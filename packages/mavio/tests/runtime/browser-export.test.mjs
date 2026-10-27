import assert from "node:assert/strict";
import test from "node:test";
import { createMavio } from "@vormirtech/mavio/browser";
import { createMavioError } from "../../dist/core/errors.js";
import { createBrowserEngine } from "../../dist/engines/browser/adapter.js";

function context(controller = new AbortController()) {
  return {
    jobId: "browser-export-test",
    signal: controller.signal,
    reportProgress() {},
  };
}

function fixture(options = {}) {
  const workers = [];
  let preparations = 0;
  const receivedPlans = [];

  const source = {
    formatStartTimeSeconds: 0,
    metadata: {
      container: "mov,mp4,m4a,3gp,3g2,mj2",
      durationSeconds: 1,
      sizeBytes: 64,
      streams: [
        {
          index: 0,
          kind: "video",
          codec: "h264",
          width: 320,
          height: 180,
        },
      ],
    },
    streams: [
      {
        index: 0,
        pixelFormat: "yuv420p",
        colorTransfer: "bt709",
        colorPrimaries: "bt709",
        colorSpace: "bt709",
        colorRange: "tv",
        sampleAspectRatio: "1:1",
        attachedPicture: false,
        defaultOrientation: true,
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
        return () => {
          const worker = {
            loaded: false,
            terminations: 0,

            async load() {
              this.loaded = true;
              return true;
            },

            terminate() {
              this.loaded = false;
              this.terminations += 1;
            },
          };

          workers.push(worker);
          return worker;
        };
      },

      async inventory() {
        return {
          encoders: options.disabled
            ? []
            : ["libx264", "aac", ...(options.trim ? ["rawvideo"] : [])],
          decoders: ["h264"],
          muxers: ["mp4", ...(options.trim ? ["framemd5"] : [])],
          demuxers: ["mov", "mp4"],
          filters: options.filters ?? [],
        };
      },

      async probeDetails() {
        return structuredClone(source);
      },

      async prepareBytes(_worker, plan) {
        preparations += 1;

        receivedPlans.push(structuredClone(plan));

        assert.equal(plan.output.kind, "bytes");

        if (options.failFirst && preparations === 1) {
          throw createMavioError("EXECUTION_FAILED", "Simulated preparation failure.");
        }

        options.afterPrepare?.();

        const metadata = structuredClone(source.metadata);

        if (options.outputWidth !== undefined) {
          metadata.streams[0].width = options.outputWidth;
        }

        if (options.outputHeight !== undefined) {
          metadata.streams[0].height = options.outputHeight;
        }

        if (options.badMetadata) {
          metadata.durationSeconds = NaN;
        }

        return {
          bytes: new Uint8Array(64).fill(7),
          metadata,
        };
      },
    },
  );

  return {
    engine,
    workers,
    client: createMavio({ engine }),
    preparations: () => preparations,
    receivedPlans,
  };
}

function plan() {
  return {
    input: { kind: "bytes", bytes: new Uint8Array([1]) },
    transformations: [
      {
        type: "convert",
        options: { format: "mp4", preset: "video-balanced-v1" },
      },
    ],
    terminal: {
      type: "export",
      format: "mp4",
      preset: "video-balanced-v1",
    },
    output: { kind: "bytes" },
  };
}

async function ready(engine, executionContext) {
  await engine.initialize(executionContext);
  await engine.probe(plan().input, executionContext);
}

test("browser export capabilities advertise implemented MP4 routes", async () => {
  const { client } = fixture();

  try {
    const capabilities = await client.capabilities();

    assert.deepEqual(capabilities.operations, ["metadata", "convert", "compress"]);
    assert.deepEqual(capabilities.outputKinds, ["bytes", "blob"]);
    assert.deepEqual(
      capabilities.encodings.map((encoding) => encoding.preset),
      ["video-balanced-v1", "video-small-v1"],
    );

    for (const encoding of capabilities.encodings) {
      assert.equal(encoding.container, "mp4");
      assert.equal(encoding.audioCodec, "aac");
      assert.equal(encoding.audioPadding, "decoder-dependent");
    }
  } finally {
    await client.dispose();
  }
});

test("missing MP4 encoder leaves browser capabilities metadata-only", async () => {
  const { client } = fixture({ disabled: true });

  try {
    const capabilities = await client.capabilities();
    assert.deepEqual(capabilities.operations, ["metadata"]);
    assert.deepEqual(capabilities.outputKinds, []);
    assert.deepEqual(capabilities.encodings, []);
  } finally {
    await client.dispose();
  }
});

test("public MP4 trim checks required features and forwards consecutive trim plans", async () => {
  const { client, receivedPlans } = fixture({ trim: true, filters: ["trim", "settb", "setpts"] });
  try {
    assert.equal((await client.capabilities()).operations.includes("trim"), true);
    for (const preset of ["video-balanced-v1", "video-small-v1"]) {
      await client
        .from({ kind: "bytes", bytes: new Uint8Array([1, 2, 3]) })
        .trim({ start: 0.125, end: 0.5 })
        .trim({ start: 0.125, end: 0.25 })
        .convert({ format: "mp4", preset })
        .export({ output: { kind: "blob" } });
    }
    assert.equal(receivedPlans.length, 2);
    for (const received of receivedPlans) {
      assert.deepEqual(
        received.transformations.filter((op) => op.type === "trim").map((op) => op.options),
        [
          { start: 0.125, end: 0.5 },
          { start: 0.125, end: 0.25 },
        ],
      );
    }
  } finally {
    await client.dispose();
  }
});

test("public browser exports support both presets and byte/Blob input/output", async () => {
  const { client, preparations } = fixture();

  try {
    for (const preset of ["video-balanced-v1", "video-small-v1"]) {
      for (const input of [
        { kind: "bytes", bytes: new Uint8Array([1]) },
        { kind: "blob", blob: new Blob(["media"]) },
      ]) {
        for (const kind of ["bytes", "blob"]) {
          const result = await client
            .from(input)
            .convert({ format: "mp4", preset })
            .export({ output: { kind } });

          assert.equal(result.output.kind, kind);
          assert.equal(result.engine.id, "browser-ffmpeg");

          if (kind === "bytes") {
            assert.equal(result.output.bytes.length, 64);
          } else {
            assert.equal(result.output.blob.size, 64);
            assert.equal(result.output.blob.type, "video/mp4");
          }
        }
      }
    }

    assert.equal(preparations(), 8);
  } finally {
    await client.dispose();
  }
});

test("a denied commit gate prevents browser output publication", async () => {
  const { engine, client, preparations } = fixture();
  const executionContext = context();
  let gates = 0;

  try {
    await ready(engine, executionContext);

    await assert.rejects(
      engine.execute(plan(), {
        ...executionContext,
        beginCommit() {
          gates += 1;
          assert.equal(preparations(), 1);
          return false;
        },
      }),
      { code: "CANCELLED" },
    );

    assert.equal(gates, 1);
  } finally {
    await engine.dispose();
    await client.dispose();
  }
});

test("cancellation after preparation prevents public export", async () => {
  const controller = new AbortController();
  const { client } = fixture({
    afterPrepare: () => controller.abort(),
  });

  try {
    await assert.rejects(
      client
        .from(plan().input)
        .convert({ format: "mp4", preset: "video-balanced-v1" })
        .export({ output: { kind: "bytes" } }, { signal: controller.signal }),
      { code: "CANCELLED" },
    );
  } finally {
    await client.dispose();
  }
});

test("an accepted gate returns output despite a subsequent abort", async () => {
  const { engine, client } = fixture();
  const controller = new AbortController();
  const executionContext = context(controller);
  let gates = 0;

  try {
    await ready(engine, executionContext);

    const result = await engine.execute(plan(), {
      ...executionContext,
      beginCommit() {
        gates += 1;
        controller.abort();
        return true;
      },
    });

    assert.equal(gates, 1);
    assert.equal(result.output.kind, "bytes");
  } finally {
    await engine.dispose();
    await client.dispose();
  }
});

test("public preparation failure resets the worker and permits recovery", async () => {
  const { client, workers } = fixture({ failFirst: true });

  try {
    const pipeline = client
      .from(plan().input)
      .convert({ format: "mp4", preset: "video-balanced-v1" });

    await assert.rejects(pipeline.export({ output: { kind: "bytes" } }), {
      code: "EXECUTION_FAILED",
    });

    assert.equal(workers[0].terminations, 1);

    const recovered = await pipeline.export({
      output: { kind: "bytes" },
    });

    assert.equal(recovered.output.bytes.length, 64);
    assert.equal(workers.length, 2);
  } finally {
    await client.dispose();
  }
});

test("invalid prepared metadata rejects before requesting the commit gate", async () => {
  const { engine, client } = fixture({ badMetadata: true });
  const executionContext = context();
  let gates = 0;

  try {
    await ready(engine, executionContext);

    await assert.rejects(
      engine.execute(plan(), {
        ...executionContext,
        beginCommit() {
          gates += 1;
          return true;
        },
      }),
      { code: "EXECUTION_FAILED" },
    );

    assert.equal(gates, 0);
  } finally {
    await engine.dispose();
    await client.dispose();
  }
});

test("browser resize capability requires both scaling filters", async () => {
  for (const filters of [[], ["scale"], ["setsar"], ["scale", "setsar"]]) {
    const { client } = fixture({ filters });

    try {
      const capabilities = await client.capabilities();

      assert.equal(
        capabilities.operations.includes("resize"),
        filters.includes("scale") && filters.includes("setsar"),
      );

      assert.equal(capabilities.operations.includes("convert"), true);
    } finally {
      await client.dispose();
    }
  }
});

test("resize filters do not enable exports without the MP4 encoder", async () => {
  const { client } = fixture({
    disabled: true,
    filters: ["scale", "setsar"],
  });

  try {
    const capabilities = await client.capabilities();

    assert.deepEqual(capabilities.operations, ["metadata"]);
    assert.deepEqual(capabilities.outputKinds, []);
  } finally {
    await client.dispose();
  }
});

test("public browser resize routes both presets and byte/Blob inputs and outputs", async () => {
  const { client, preparations, receivedPlans } = fixture({
    filters: ["scale", "setsar"],
    outputWidth: 160,
    outputHeight: 90,
  });

  const bytes = new Uint8Array([1, 2, 3]);
  const snapshot = bytes.slice();
  const blob = new Blob([bytes]);
  const outputs = [];

  try {
    for (const preset of ["video-balanced-v1", "video-small-v1"]) {
      for (const input of [
        { kind: "bytes", bytes },
        { kind: "blob", blob },
      ]) {
        for (const kind of ["bytes", "blob"]) {
          const result = await client
            .from(input)
            .resize({ width: 160, height: 90 })
            .resize({ width: 640, height: 360 })
            .convert({ format: "mp4", preset })
            .export({ output: { kind } });

          const video = result.metadata.streams.find((stream) => stream.kind === "video");

          assert.equal(video.width, 160);
          assert.equal(video.height, 90);
          assert.equal(result.output.kind, kind);
          assert.equal(result.engine.id, "browser-ffmpeg");

          outputs.push(result.output);
        }
      }
    }

    assert.equal(preparations(), 8);
    assert.equal(receivedPlans.length, 8);

    for (const received of receivedPlans) {
      assert.deepEqual(
        received.transformations.map((transformation) => transformation.type),
        ["resize", "resize", "convert"],
      );

      assert.deepEqual(received.transformations[1].options, { width: 640, height: 360 });

      assert.equal(received.output.kind, "bytes");
    }

    assert.deepEqual(bytes, snapshot);

    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), snapshot);
  } finally {
    await client.dispose();
  }

  // Returned outputs remain owned by the caller after disposal.
  for (const output of outputs) {
    const returned =
      output.kind === "bytes" ? output.bytes : new Uint8Array(await output.blob.arrayBuffer());

    assert.equal(returned.length, 64);
    assert.ok(returned.every((value) => value === 7));

    if (output.kind === "blob") {
      assert.equal(output.blob.type, "video/mp4");
    }
  }
});

test("public resize without required filters rejects before preparation", async () => {
  for (const filters of [[], ["scale"], ["setsar"]]) {
    const { client, preparations } = fixture({ filters });

    try {
      await assert.rejects(
        client
          .from(plan().input)
          .resize({ width: 160, height: 90 })
          .convert({
            format: "mp4",
            preset: "video-balanced-v1",
          })
          .export({ output: { kind: "bytes" } }),
        {
          code: "UNSUPPORTED_CAPABILITY",
        },
      );

      assert.equal(preparations(), 0);
    } finally {
      await client.dispose();
    }
  }
});

test("browser support validation rejects unrepresentable resize dimensions", async () => {
  const { engine, client, preparations } = fixture({
    filters: ["scale", "setsar"],
  });

  const executionContext = context();

  try {
    await ready(engine, executionContext);

    const requested = plan();

    requested.transformations.unshift({
      type: "resize",
      options: { width: 1, height: 1 },
    });

    const support = await engine.supports(requested);

    assert.equal(support.status, "unsupported");

    assert.ok(support.issues.some((issue) => issue.code === "INVALID_OPTIONS"));

    assert.equal(preparations(), 0);
  } finally {
    await engine.dispose();
    await client.dispose();
  }
});
