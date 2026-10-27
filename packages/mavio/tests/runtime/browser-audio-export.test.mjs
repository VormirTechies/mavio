import assert from "node:assert/strict";
import test from "node:test";
import { createMavio } from "@vormirtech/mavio/browser";
import { createMavioError } from "../../dist/core/errors.js";
import { createBrowserEngine } from "../../dist/engines/browser/adapter.js";

function fixture(options = {}) {
  const plans = [];
  const workers = [];
  const returned = [];

  const source = {
    metadata: {
      container: "wav",
      durationSeconds: 0.25,
      sizeBytes: 64,
      streams: [
        {
          index: 3,
          kind: "audio",
          codec: "pcm_s16le",
          sampleRate: 48000,
          channels: 2,
        },
      ],
    },
    streams: [{ index: 3, channelLayout: "stereo" }],
  };

  const engine = createBrowserEngine(
    {
      assets: {
        coreURL: "/core.js",
        wasmURL: "/core.wasm",
        classWorkerURL: "/worker.js",
      },
    },
    {
      environment: {
        pageURL: "https://mavio.example/",
        baseURL: "https://mavio.example/",
      },

      async loader() {
        return () => {
          const worker = {
            loaded: false,

            async load() {
              this.loaded = true;
              return true;
            },

            terminate() {
              this.loaded = false;
            },
          };

          workers.push(worker);
          return worker;
        };
      },

      async inventory() {
        return {
          encoders: options.encoders ?? ["libmp3lame", "pcm_s16le"],
          muxers: options.muxers ?? ["mp3", "wav"],
          decoders: ["pcm_s16le"],
          demuxers: ["wav"],
          filters: options.filters ?? [],
        };
      },

      async probeDetails() {
        return structuredClone(source);
      },

      async prepareBytes() {
        throw new Error("Audio must not use MP4 preparation.");
      },

      async prepareAudioBytes(_worker, plan) {
        plans.push(structuredClone(plan));
        assert.equal(plan.output.kind, "bytes");

        if (options.failFirst && plans.length === 1) {
          throw createMavioError("EXECUTION_FAILED", "Simulated audio preparation failure.", {
            stage: "running",
          });
        }

        const mp3 = plan.terminal.preset === "audio-balanced-v1";
        const metadata = structuredClone(source.metadata);
        metadata.container = mp3 ? "mp3" : "wav";
        metadata.streams[0].index = 0;
        metadata.streams[0].codec = mp3 ? "mp3" : "pcm_s16le";

        const bytes = new Uint8Array(64).fill(mp3 ? 7 : 9);
        returned.push({ bytes, metadata });

        return { bytes, metadata };
      },
    },
  );

  return {
    engine,
    client: createMavio({ engine }),
    plans,
    workers,
    returned,
  };
}

function exportAudio(client, preset, output = "bytes") {
  return client
    .from({ kind: "bytes", bytes: new Uint8Array([1, 2, 3]) })
    .convert({
      format: preset === "audio-balanced-v1" ? "mp3" : "wav",
      preset,
    })
    .export({ output: { kind: output } });
}

test("audio-only browser inventory advertises implemented public routes", async () => {
  const { client } = fixture();

  try {
    const capabilities = await client.capabilities();

    assert.deepEqual(capabilities.operations, ["metadata", "convert", "compress", "extractAudio"]);

    assert.deepEqual(capabilities.outputKinds, ["bytes", "blob"]);

    assert.deepEqual(
      capabilities.encodings.map((encoding) => encoding.preset),
      ["audio-balanced-v1", "audio-pcm-v1"],
    );
  } finally {
    await client.dispose();
  }
});

test("browser audio capabilities require each preset's encoder and muxer", async () => {
  for (const options of [{ encoders: ["pcm_s16le"] }, { muxers: ["wav"] }]) {
    const { client } = fixture(options);

    try {
      const capabilities = await client.capabilities();

      assert.deepEqual(
        capabilities.encodings.map((encoding) => encoding.preset),
        ["audio-pcm-v1"],
      );
    } finally {
      await client.dispose();
    }
  }

  const { client } = fixture({ encoders: [] });

  try {
    const capabilities = await client.capabilities();

    assert.deepEqual(capabilities.operations, ["metadata"]);
    assert.deepEqual(capabilities.outputKinds, []);
    assert.deepEqual(capabilities.encodings, []);
  } finally {
    await client.dispose();
  }
});

test("public browser audio routes both presets through convert and compress", async () => {
  const { client, plans } = fixture();

  try {
    for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
      const format = preset === "audio-balanced-v1" ? "mp3" : "wav";
      const mime = format === "mp3" ? "audio/mpeg" : "audio/wav";

      for (const input of [
        { kind: "bytes", bytes: new Uint8Array([1, 2, 3]) },
        { kind: "blob", blob: new Blob(["source"]) },
      ]) {
        for (const kind of ["bytes", "blob"]) {
          for (const operation of ["convert", "compress"]) {
            const pipeline = client.from(input);

            const transformed =
              operation === "convert"
                ? pipeline.convert({ format, preset })
                : pipeline.compress({ preset });

            const result = await transformed.export({
              format,
              output: { kind },
            });

            assert.equal(result.output.kind, kind);
            assert.equal(result.metadata.container, format);
            assert.equal(result.engine.id, "browser-ffmpeg");

            if (kind === "bytes") {
              assert.equal(result.output.bytes.length, 64);
            } else {
              assert.equal(result.output.blob.size, 64);
              assert.equal(result.output.blob.type, mime);
            }
          }
        }
      }
    }

    assert.equal(plans.length, 16);
  } finally {
    await client.dispose();
  }
});

test("public browser audio preserves explicit extraction selection", async () => {
  const { client, plans } = fixture();

  try {
    await client
      .from({ kind: "bytes", bytes: new Uint8Array([1]) })
      .extractAudio({ streamIndex: 3 })
      .convert({ format: "wav", preset: "audio-pcm-v1" })
      .export({ output: { kind: "bytes" } });

    assert.equal(
      plans[0].transformations.find((operation) => operation.type === "extractAudio").options
        .streamIndex,
      3,
    );
  } finally {
    await client.dispose();
  }
});

test("invalid audio stream selection rejects before preparation", async () => {
  const { client, plans } = fixture();

  try {
    await assert.rejects(
      client
        .from({ kind: "bytes", bytes: new Uint8Array([1]) })
        .extractAudio({ streamIndex: 1 })
        .convert({ format: "wav", preset: "audio-pcm-v1" })
        .export({ output: { kind: "bytes" } }),
      { code: "INVALID_OPTIONS" },
    );

    assert.equal(plans.length, 0);

    await exportAudio(client, "audio-pcm-v1");
    assert.equal(plans.length, 1);
  } finally {
    await client.dispose();
  }
});

test("public browser audio recovers after preparation failure", async () => {
  const { client, plans } = fixture({ failFirst: true });

  try {
    await assert.rejects(exportAudio(client, "audio-balanced-v1"), { code: "EXECUTION_FAILED" });

    const result = await exportAudio(client, "audio-balanced-v1");

    assert.equal(result.output.kind, "bytes");
    assert.equal(plans.length, 2);
  } finally {
    await client.dispose();
  }
});

test("public audio results remain independent after disposal", async () => {
  const { client, returned } = fixture();

  const result = await exportAudio(client, "audio-pcm-v1");
  const snapshot = result.output.bytes.slice();

  await client.dispose();

  returned[0].bytes.fill(0);
  returned[0].metadata.streams[0].sampleRate = 1;

  assert.deepEqual(result.output.bytes, snapshot);
  assert.equal(result.metadata.streams[0].sampleRate, 48000);
});

test("a denied commit gate prevents audio publication", async () => {
  const { engine, plans } = fixture();

  const context = {
    jobId: "audio-commit-test",
    signal: new AbortController().signal,
    reportProgress() {},
    beginCommit() {
      assert.equal(plans.length, 1);
      return false;
    },
  };

  const plan = {
    input: { kind: "bytes", bytes: new Uint8Array([1]) },
    transformations: [],
    terminal: {
      type: "export",
      format: "wav",
      preset: "audio-pcm-v1",
    },
    output: { kind: "bytes" },
  };

  try {
    await engine.initialize(context);
    await engine.probe(plan.input, context);

    await assert.rejects(engine.execute(plan, context), {
      code: "CANCELLED",
      stage: "finalizing",
    });
  } finally {
    await engine.dispose();
  }
});

function trimFixture(options = {}) {
  return fixture({
    encoders: ["libmp3lame", "pcm_s16le", "pcm_f32le"],
    muxers: ["mp3", "wav", "framemd5"],
    filters: ["atrim", "asetpts"],
    ...options,
  });
}

test("browser capabilities advertise audio trim when all required features exist", async () => {
  const { client } = trimFixture();

  try {
    const capabilities = await client.capabilities();

    assert.deepEqual(capabilities.operations, [
      "metadata",
      "convert",
      "compress",
      "extractAudio",
      "trim",
    ]);
  } finally {
    await client.dispose();
  }
});

test("browser audio trim capability requires filters, analysis features and an output encoder", async () => {
  for (const options of [
    { filters: ["atrim"] },
    { filters: ["asetpts"] },
    { encoders: ["libmp3lame", "pcm_s16le"] },
    { muxers: ["mp3", "wav"] },
    { encoders: ["pcm_f32le"] },
  ]) {
    const { client } = trimFixture(options);

    try {
      const capabilities = await client.capabilities();
      assert.equal(capabilities.operations.includes("trim"), false);
    } finally {
      await client.dispose();
    }
  }
});

test("public browser audio trim routes both presets and byte/Blob input/output", async () => {
  const { client, plans } = trimFixture();

  try {
    for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
      const format = preset === "audio-balanced-v1" ? "mp3" : "wav";

      for (const input of [
        { kind: "bytes", bytes: new Uint8Array([1]) },
        { kind: "blob", blob: new Blob(["source"]) },
      ]) {
        for (const outputKind of ["bytes", "blob"]) {
          const result = await client
            .from(input)
            .trim({ start: 0.03125, end: 0.21875 })
            .trim({ start: 0.03125, end: 0.15625 })
            .convert({ format, preset })
            .export({
              format,
              output: { kind: outputKind },
            });

          assert.equal(result.output.kind, outputKind);

          const received = plans.at(-1);

          assert.equal(received.output.kind, "bytes");

          assert.deepEqual(
            received.transformations
              .filter((operation) => operation.type === "trim")
              .map((operation) => operation.options),
            [
              { start: 0.03125, end: 0.21875 },
              { start: 0.03125, end: 0.15625 },
            ],
          );
        }
      }
    }

    assert.equal(plans.length, 8);
  } finally {
    await client.dispose();
  }
});

test("out-of-range public audio trim rejects before preparation and permits recovery", async () => {
  const { client, plans } = trimFixture();

  try {
    await assert.rejects(
      client
        .from({ kind: "bytes", bytes: new Uint8Array([1]) })
        .trim({ start: 0, end: 0.5 })
        .convert({ format: "wav", preset: "audio-pcm-v1" })
        .export({ output: { kind: "bytes" } }),
      { code: "INVALID_OPTIONS" },
    );

    assert.equal(plans.length, 0);

    await client
      .from({ kind: "bytes", bytes: new Uint8Array([1]) })
      .trim({ start: 0.0625, end: 0.1875 })
      .convert({ format: "wav", preset: "audio-pcm-v1" })
      .export({ output: { kind: "bytes" } });

    assert.equal(plans.length, 1);
  } finally {
    await client.dispose();
  }
});

test("public audio trim preserves explicit extraction selection", async () => {
  const { client, plans } = trimFixture();

  try {
    await client
      .from({ kind: "bytes", bytes: new Uint8Array([1]) })
      .extractAudio({ streamIndex: 3 })
      .trim({ start: 0.0625, end: 0.1875 })
      .convert({ format: "mp3", preset: "audio-balanced-v1" })
      .export({ output: { kind: "bytes" } });

    assert.equal(
      plans[0].transformations.find((operation) => operation.type === "extractAudio").options
        .streamIndex,
      3,
    );

    assert.equal(
      plans[0].transformations.some((operation) => operation.type === "trim"),
      true,
    );
  } finally {
    await client.dispose();
  }
});

test("advertising audio trim does not enable MP4 without the video encoder", async () => {
  const { engine } = trimFixture();

  const context = {
    jobId: "browser-video-trim-gate",
    signal: new AbortController().signal,
    reportProgress() {},
  };

  const plan = {
    input: { kind: "bytes", bytes: new Uint8Array([1]) },
    transformations: [
      {
        type: "trim",
        options: { start: 0, end: 0.125 },
      },
    ],
    terminal: {
      type: "export",
      format: "mp4",
      preset: "video-balanced-v1",
    },
    output: { kind: "bytes" },
  };

  try {
    await engine.initialize(context);
    await engine.probe(plan.input, context);

    const support = await engine.supports(plan);

    assert.equal(support.status, "unsupported");
    assert.equal(support.issues[0].code, "UNSUPPORTED_CAPABILITY");
    assert.match(support.issues[0].message, /lacks the required video trim features/);
  } finally {
    await engine.dispose();
  }
});
