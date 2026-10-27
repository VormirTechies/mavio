import assert from "node:assert/strict";
import test from "node:test";
import { createMavio } from "@vormirtech/mavio/browser";
import { createMavioError } from "../../dist/core/errors.js";
import { createBrowserEngine } from "../../dist/engines/browser/adapter.js";

function fixture(options = {}) {
  const plans = [];
  const returned = [];

  const source = {
    metadata: {
      container: "mov,mp4,m4a,3gp,3g2,mj2",
      durationSeconds: 0.5,
      sizeBytes: 64,
      streams: [
        {
          index: 0,
          kind: "video",
          codec: "h264",
          width: 160,
          height: 90,
        },
      ],
    },
    formatStartTimeSeconds: 0,
    streams: [
      {
        index: 0,
        pixelFormat: "yuv420p",
        colorTransfer: "bt709",
        colorPrimaries: "bt709",
        colorSpace: "bt709",
        colorRange: "tv",
        attachedPicture: false,
        defaultOrientation: true,
        sampleAspectRatio: "1:1",
      },
    ],
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
        return () => ({
          loaded: false,

          async load() {
            this.loaded = true;
            return true;
          },

          terminate() {
            this.loaded = false;
          },
        });
      },

      async inventory() {
        return {
          encoders: options.encoders ?? ["mjpeg", "png", "rawvideo"],
          muxers: options.muxers ?? ["image2pipe", "framemd5"],
          decoders: ["h264"],
          demuxers: ["mov"],
          filters: options.filters ?? ["trim", "setpts", "scale", "format", "setsar"],
        };
      },

      async probeDetails() {
        return structuredClone(source);
      },

      async prepareBytes() {
        throw new Error("Thumbnails must not use MP4 preparation.");
      },

      async prepareAudioBytes() {
        throw new Error("Thumbnails must not use audio preparation.");
      },

      async prepareThumbnailBytes(_worker, plan) {
        plans.push(structuredClone(plan));
        assert.equal(plan.output.kind, "bytes");

        if (options.failFirst && plans.length === 1) {
          throw createMavioError("EXECUTION_FAILED", "Simulated thumbnail preparation failure.", {
            stage: "running",
          });
        }

        const bytes = new Uint8Array(64).fill(7);
        const metadata = {
          sizeBytes: 64,
          streams: [
            {
              index: 0,
              kind: "video",
              codec: plan.terminal.format === "jpeg" ? "mjpeg" : "png",
              width: options.width ?? 160,
              height: options.height ?? 90,
            },
          ],
        };

        returned.push({ bytes, metadata });

        return { bytes, metadata };
      },
    },
  );

  return {
    engine,
    client: createMavio({ engine }),
    plans,
    returned,
  };
}

function thumbnail(client, format = "jpeg", output = "bytes") {
  return client.from({ kind: "bytes", bytes: new Uint8Array([1]) }).thumbnail({
    at: 0.125,
    format,
    preset: format === "jpeg" ? "jpeg-balanced-v1" : "png-lossless-v1",
    output: { kind: output },
  });
}

test("thumbnail-only browser inventory advertises implemented image routes", async () => {
  const { client } = fixture();

  try {
    const capabilities = await client.capabilities();

    assert.deepEqual(capabilities.operations, ["metadata", "resize", "trim", "thumbnail"]);

    assert.deepEqual(capabilities.outputKinds, ["bytes", "blob"]);

    assert.deepEqual(
      capabilities.encodings.map((encoding) => encoding.preset),
      ["jpeg-balanced-v1", "png-lossless-v1"],
    );
  } finally {
    await client.dispose();
  }
});

test("browser thumbnail capabilities require analysis, conversion and image encoding features", async () => {
  for (const options of [
    { encoders: ["mjpeg", "png"] },
    { encoders: ["rawvideo"] },
    { muxers: ["image2pipe"] },
    { muxers: ["framemd5"] },
    { filters: ["trim", "setpts", "scale"] },
  ]) {
    const { client } = fixture(options);

    try {
      const capabilities = await client.capabilities();

      assert.equal(capabilities.operations.includes("thumbnail"), false);
      assert.deepEqual(capabilities.encodings, []);
    } finally {
      await client.dispose();
    }
  }

  const { client } = fixture({ encoders: ["mjpeg", "rawvideo"] });

  try {
    const capabilities = await client.capabilities();

    assert.deepEqual(
      capabilities.encodings.map((encoding) => encoding.preset),
      ["jpeg-balanced-v1"],
    );
  } finally {
    await client.dispose();
  }
});

test("public browser thumbnails support both formats and byte/Blob input/output", async () => {
  const { client, plans } = fixture();

  try {
    for (const format of ["jpeg", "png"]) {
      for (const input of [
        { kind: "bytes", bytes: new Uint8Array([1]) },
        { kind: "blob", blob: new Blob(["source"]) },
      ]) {
        for (const output of ["bytes", "blob"]) {
          const result = await client.from(input).thumbnail({
            at: 0.125,
            format,
            preset: format === "jpeg" ? "jpeg-balanced-v1" : "png-lossless-v1",
            output: { kind: output },
          });

          assert.equal(result.output.kind, output);
          assert.equal(result.engine.id, "browser-ffmpeg");

          if (output === "blob") {
            assert.equal(result.output.blob.type, `image/${format}`);
          } else {
            assert.equal(result.output.bytes.length, 64);
          }
        }
      }
    }

    assert.equal(plans.length, 8);
  } finally {
    await client.dispose();
  }
});

test("public thumbnails preserve preceding trim and resize operations", async () => {
  const { client, plans } = fixture({ width: 80, height: 44 });

  try {
    await client
      .from({ kind: "bytes", bytes: new Uint8Array([1]) })
      .trim({ start: 0.0625, end: 0.375 })
      .resize({ width: 80, height: 45 })
      .thumbnail({
        at: 0.0625,
        format: "jpeg",
        preset: "jpeg-balanced-v1",
        output: { kind: "bytes" },
      });

    assert.deepEqual(
      plans[0].transformations.map((operation) => operation.type),
      ["trim", "resize"],
    );
    assert.equal(plans[0].terminal.at, 0.0625);
  } finally {
    await client.dispose();
  }
});

test("public thumbnails reject mismatched format and preset before preparation", async () => {
  const { client, plans } = fixture();

  try {
    await assert.rejects(
      client.from({ kind: "bytes", bytes: new Uint8Array([1]) }).thumbnail({
        at: 0.125,
        format: "png",
        preset: "jpeg-balanced-v1",
        output: { kind: "bytes" },
      }),
      { code: "INVALID_OPTIONS" },
    );

    assert.equal(plans.length, 0);

    await thumbnail(client);
    assert.equal(plans.length, 1);
  } finally {
    await client.dispose();
  }
});

test("public thumbnails recover after preparation failure", async () => {
  const { client, plans } = fixture({ failFirst: true });

  try {
    await assert.rejects(thumbnail(client), {
      code: "EXECUTION_FAILED",
    });

    const result = await thumbnail(client, "png", "blob");

    assert.equal(result.output.blob.type, "image/png");
    assert.equal(plans.length, 2);
  } finally {
    await client.dispose();
  }
});

test("public thumbnail results remain independent after disposal", async () => {
  const { client, returned } = fixture();

  const result = await thumbnail(client);
  const snapshot = result.output.bytes.slice();

  await client.dispose();

  returned[0].bytes.fill(0);
  returned[0].metadata.streams[0].width = 1;

  assert.deepEqual(result.output.bytes, snapshot);
  assert.equal(result.metadata.streams[0].width, 160);
});

test("a denied commit gate prevents thumbnail publication", async () => {
  const { engine, plans } = fixture();

  const context = {
    jobId: "thumbnail-commit-test",
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
      type: "thumbnail",
      at: 0.125,
      format: "jpeg",
      preset: "jpeg-balanced-v1",
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
