import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createMavio as createBrowser } from "@vormir/mavio/browser";
import { createMavio as createNode } from "@vormir/mavio/node";

function mockEngine(runtime, source, outputMetadata) {
  const calls = [];
  const plans = [];
  const inputs = [];
  const published = new Map();
  const payload = new Uint8Array([7, 8, 9]);

  const engine = {
    id: `acceptance-${runtime}`,
    runtime,

    async initialize() {
      calls.push("initialize");
    },

    async capabilities() {
      calls.push("capabilities");

      return {
        engineId: engine.id,
        engineVersion: "mock-v1",
        runtime,
        operations: ["metadata", "trim", "resize", "extractAudio", "convert"],
        inputKinds: runtime === "browser" ? ["blob", "bytes"] : ["path", "bytes"],
        outputKinds: runtime === "browser" ? ["blob", "bytes"] : ["path", "bytes"],
        readableContainers: ["mp4"],
        decoders: ["h264", "aac"],
        encodings: [
          { container: "mp4", preset: "video-balanced-v1" },
          { container: "wav", preset: "audio-pcm-v1" },
        ],
        limits: {},
      };
    },

    async probe(input) {
      calls.push("probe");
      inputs.push(input);
      return source;
    },

    async supports(plan, metadata) {
      calls.push("supports");
      assert.deepEqual(metadata, source);
      assert.ok(Object.isFrozen(plan));
      return { status: "supported" };
    },

    async execute(plan, context) {
      calls.push("execute");
      plans.push(plan);

      assert.equal(context.beginCommit(), true);
      calls.push("commit");

      let output;

      if (plan.output.kind === "path") {
        // In-memory publication model only: no files are created.
        if (published.has(plan.output.path)) {
          throw Object.assign(new Error("Destination already exists."), {
            name: "MavioError",
            code: "OUTPUT_EXISTS",
          });
        }

        published.set(plan.output.path, new Uint8Array(payload));
        output = { kind: "path", path: plan.output.path };
      } else {
        assert.equal(plan.output.kind, "blob");

        output = {
          kind: "blob",
          blob: new Blob([payload], { type: "video/mp4" }),
        };
      }

      return { output, metadata: outputMetadata };
    },

    async dispose() {
      calls.push("dispose");

      // Returned results must survive changes to adapter-owned storage.
      payload.fill(0);
      outputMetadata.durationSeconds = 999;
      outputMetadata.streams.length = 0;
    },
  };

  return { engine, calls, plans, inputs, published };
}

const sourceMetadata = () => ({
  durationSeconds: 8,
  streams: [
    { index: 0, kind: "video", codec: "h264", width: 640, height: 360 },
    { index: 3, kind: "audio", codec: "aac", channels: 2 },
    { index: 7, kind: "audio", codec: "aac", channels: 2 },
  ],
});

test("browser acceptance: Blob to trim to resize to MP4 Blob", async () => {
  const mock = mockEngine("browser", sourceMetadata(), {
    durationSeconds: 2,
    streams: [
      { index: 0, kind: "video", width: 320, height: 180 },
      { index: 1, kind: "audio", channels: 2 },
    ],
  });

  const client = createBrowser({ engine: mock.engine });
  const blob = new Blob(["mock source"], { type: "video/mp4" });
  const events = [];

  try {
    const pipeline = client
      .from({ kind: "blob", blob })
      .trim({ start: 1, end: 3 })
      .resize({ width: 320, height: 180 })
      .convert({ format: "mp4", preset: "video-balanced-v1" });

    assert.deepEqual(mock.calls, []);

    const first = await pipeline.export(
      { output: { kind: "blob" } },
      { onProgress: (event) => events.push(event) },
    );

    assert.deepEqual(mock.calls, [
      "initialize",
      "capabilities",
      "probe",
      "supports",
      "execute",
      "commit",
    ]);

    const plan = mock.plans[0];

    assert.equal(plan.input.blob, blob);
    assert.deepEqual(plan.transformations, [
      { type: "trim", options: { start: 1, end: 3 } },
      { type: "resize", options: { width: 320, height: 180 } },
      {
        type: "convert",
        options: { format: "mp4", preset: "video-balanced-v1" },
      },
    ]);
    assert.deepEqual(plan.terminal, {
      type: "export",
      format: "mp4",
      preset: "video-balanced-v1",
    });
    assert.deepEqual(plan.output, { kind: "blob" });

    assert.deepEqual(
      events.map((event) => event.stage),
      ["queued", "preparing", "running", "finalizing", "completed"],
    );
    assert.ok(events.every((event) => event.jobId === first.jobId));

    const second = await pipeline.export({ output: { kind: "blob" } });

    assert.notEqual(first.jobId, second.jobId);
    assert.equal(mock.calls.filter((call) => call === "initialize").length, 1);

    await client.dispose();

    for (const result of [first, second]) {
      assert.equal(result.output.kind, "blob");
      assert.equal(result.output.blob.type, "video/mp4");
      assert.deepEqual([...new Uint8Array(await result.output.blob.arrayBuffer())], [7, 8, 9]);
      assert.equal(result.metadata.durationSeconds, 2);
      assert.equal(result.metadata.streams[0].width, 320);
      assert.deepEqual(result.engine, {
        id: "acceptance-browser",
        version: "mock-v1",
      });
    }

    assert.equal(await blob.text(), "mock source");
  } finally {
    await client.dispose();
  }
});

test("Node acceptance: path to selected audio stream to WAV path", async () => {
  const mock = mockEngine("node", sourceMetadata(), {
    durationSeconds: 8,
    streams: [
      {
        index: 0,
        kind: "audio",
        codec: "pcm_s16le",
        channels: 2,
        sampleRate: 48000,
      },
    ],
  });

  const client = createNode({ engine: mock.engine });
  const inputPath = resolve("fixtures", "source.mp4");
  const outputPath = resolve("results", "selected-audio.wav");
  const events = [];

  try {
    const pipeline = client
      .from({ kind: "path", path: "fixtures/source.mp4" })
      .extractAudio({ streamIndex: 7 })
      .convert({ format: "wav", preset: "audio-pcm-v1" });

    assert.deepEqual(mock.calls, []);

    const result = await pipeline.export(
      { output: { kind: "path", path: "results/selected-audio.wav" } },
      { onProgress: (event) => events.push(event) },
    );

    assert.deepEqual(mock.inputs[0], { kind: "path", path: inputPath });

    const plan = mock.plans[0];

    assert.deepEqual(plan.transformations, [
      { type: "extractAudio", options: { streamIndex: 7 } },
      {
        type: "convert",
        options: { format: "wav", preset: "audio-pcm-v1" },
      },
    ]);
    assert.deepEqual(plan.terminal, {
      type: "export",
      format: "wav",
      preset: "audio-pcm-v1",
    });
    assert.deepEqual(plan.output, { kind: "path", path: outputPath });
    assert.deepEqual(result.output, { kind: "path", path: outputPath });

    assert.deepEqual(
      events.map((event) => event.stage),
      ["queued", "preparing", "running", "finalizing", "completed"],
    );
    assert.ok(events.every((event) => event.jobId === result.jobId));

    // The mock refuses a second publication to the occupied target.
    await assert.rejects(
      pipeline.export({
        output: { kind: "path", path: "results/selected-audio.wav" },
      }),
      { code: "OUTPUT_EXISTS" },
    );

    assert.equal(mock.published.size, 1);
    assert.deepEqual([...mock.published.get(outputPath)], [7, 8, 9]);

    await client.dispose();

    assert.equal(result.metadata.durationSeconds, 8);
    assert.equal(result.metadata.streams[0].kind, "audio");
    assert.equal(result.metadata.streams[0].sampleRate, 48000);
    assert.equal(result.output.path, outputPath);
  } finally {
    await client.dispose();
  }
});
