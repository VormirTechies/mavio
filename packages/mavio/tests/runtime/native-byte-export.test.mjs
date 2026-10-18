import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createMavio } from "../../dist/node.js";
import { createMavioError } from "../../dist/core/errors.js";
import { createNativeEngine } from "../../dist/engines/native/adapter.js";

function fixture(hooks = {}) {
  const events = [];
  const metadata = {
    durationSeconds: 2,
    sizeBytes: 3,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    streams: [
      {
        index: 0,
        kind: "video",
        codec: "h264",
        width: 320,
        height: 180,
      },
    ],
  };

  const engine = createNativeEngine(
    {},
    {
      async prepare() {
        return {
          ffmpeg: { path: resolve("ffmpeg"), version: "test" },
          ffprobe: { path: resolve("ffprobe"), version: "test" },
        };
      },
      async inventory() {
        return {
          encoders: ["libx264", "aac", ...(hooks.trim ? ["rawvideo", "pcm_f32le"] : [])],
          decoders: [],
          muxers: ["mp4", ...(hooks.trim ? ["framemd5"] : [])],
          demuxers: [],
          filters: [
            ...(hooks.trim ? ["trim", "settb", "setpts", "atrim", "asetpts"] : []),
            ...(hooks.resize ? ["scale", "setsar"] : []),
          ],
        };
      },
      async probeDetails() {
        return {
          metadata: structuredClone(metadata),
          formatStartTimeSeconds: hooks.origin ?? 0,
          streams: [
            {
              index: 0,
              attachedPicture: false,
              pixelFormat: "yuv420p",
              colorTransfer: "bt709",
              colorPrimaries: "bt709",
              colorSpace: "bt709",
              colorRange: "tv",
              sampleAspectRatio: hooks.sampleAspectRatio ?? "1:1",
              defaultOrientation: hooks.defaultOrientation ?? true,
            },
          ],
        };
      },
      async workspace() {
        events.push("workspace");
        await hooks.workspace?.();

        return {
          async dispose() {
            events.push("cleanup");
            await hooks.cleanup?.();
          },
        };
      },
      async prepareBytes(options) {
        events.push("prepare-bytes");
        await hooks.prepare?.(options);

        const outputMetadata = structuredClone(metadata);

        if (hooks.outputDimensions) {
          Object.assign(outputMetadata.streams[0], hooks.outputDimensions);
        }

        return {
          bytes: new Uint8Array([1, 2, 3]),
          metadata: outputMetadata,
        };
      },
    },
  );

  const plan = {
    input: { kind: "path", path: resolve("source.mp4") },
    transformations: [],
    terminal: {
      type: "export",
      format: "mp4",
      preset: "video-balanced-v1",
    },
    output: { kind: "bytes" },
  };

  return { engine, events, plan };
}

function context(signal = new AbortController().signal) {
  return {
    jobId: "native-byte-export",
    signal,
    reportProgress() {},
    beginCommit() {
      return true;
    },
  };
}

test("public native byte export advertises its route and cleans up before returning", async () => {
  const state = fixture();
  const client = createMavio({ engine: state.engine });

  try {
    const capabilities = await client.capabilities();

    for (const preset of ["video-balanced-v1", "video-small-v1"]) {
      const encoding = capabilities.encodings.find((item) => item.preset === preset);

      assert.ok(encoding);
      assert.equal(encoding.audioCodec, "aac");
      assert.equal(encoding.audioPadding, "decoder-dependent");
    }

    assert.deepEqual(capabilities.operations, ["metadata", "convert", "compress"]);
    assert.deepEqual(capabilities.outputKinds, ["bytes", "path"]);

    const result = await client
      .from({ kind: "path", path: resolve("source.mp4") })
      .compress({ preset: "video-balanced-v1" })
      .export({ format: "mp4", output: { kind: "bytes" } });

    assert.equal(result.output.kind, "bytes");
    assert.deepEqual([...result.output.bytes], [1, 2, 3]);
    assert.deepEqual(state.events, ["workspace", "prepare-bytes", "cleanup"]);
  } finally {
    await client.dispose();
  }
});

test("cleanup failure prevents commit and remains available for disposal retry", async () => {
  let cleanups = 0;
  let commits = 0;
  const state = fixture({
    cleanup() {
      if (++cleanups === 1) throw new Error("Cleanup failed");
    },
  });

  await state.engine.initialize(context());

  try {
    await assert.rejects(
      state.engine.execute(state.plan, {
        ...context(),
        beginCommit() {
          commits++;
          return true;
        },
      }),
      { code: "CLEANUP_FAILED" },
    );

    assert.equal(commits, 0);
  } finally {
    await state.engine.dispose();
  }

  assert.equal(cleanups, 2);
});

test("public execution preserves its primary failure when cleanup triggers cancellation", async () => {
  const controller = new AbortController();
  const state = fixture({
    prepare() {
      throw createMavioError("EXECUTION_FAILED", "Original encoding failure.");
    },
    cleanup() {
      controller.abort("late cancellation");
    },
  });

  const client = createMavio({ engine: state.engine });

  try {
    await assert.rejects(
      client
        .from({ kind: "path", path: resolve("source.mp4") })
        .compress({ preset: "video-balanced-v1" })
        .export({ format: "mp4", output: { kind: "bytes" } }, { signal: controller.signal }),
      { code: "EXECUTION_FAILED", message: "Original encoding failure." },
    );
  } finally {
    await client.dispose();
  }
});

test("commit follows cleanup and granted publication survives later cancellation", async () => {
  for (const granted of [false, true]) {
    const controller = new AbortController();
    const state = fixture();
    await state.engine.initialize(context());

    try {
      const pending = state.engine.execute(state.plan, {
        ...context(controller.signal),
        beginCommit() {
          assert.equal(state.events.at(-1), "cleanup");
          state.events.push("commit");
          if (granted) controller.abort("after grant");
          return granted;
        },
      });

      if (granted) {
        assert.deepEqual([...(await pending).output.bytes], [1, 2, 3]);
      } else {
        await assert.rejects(pending, { code: "CANCELLED" });
      }

      assert.equal(state.events.filter((event) => event === "commit").length, 1);
    } finally {
      await state.engine.dispose();
    }
  }
});

test("abort during workspace creation prevents encoding and still cleans up", async () => {
  const controller = new AbortController();
  const state = fixture({
    workspace() {
      controller.abort("stopped");
    },
  });

  await state.engine.initialize(context());

  try {
    await assert.rejects(state.engine.execute(state.plan, context(controller.signal)), {
      code: "CANCELLED",
    });

    assert.deepEqual(state.events, ["workspace", "cleanup"]);
  } finally {
    await state.engine.dispose();
  }
});

test("public trim reaches native preparation and cleans up before returning", async () => {
  let receivedPlan;

  const state = fixture({
    trim: true,
    prepare(options) {
      receivedPlan = options.plan;
    },
  });
  const client = createMavio({ engine: state.engine });

  try {
    const capabilities = await client.capabilities();
    assert.ok(capabilities.operations.includes("trim"));

    const result = await client
      .from({ kind: "path", path: resolve("source.mp4") })
      .trim({ start: 0.51, end: 1.49 })
      .compress({ preset: "video-balanced-v1" })
      .export({ format: "mp4", output: { kind: "bytes" } });

    assert.deepEqual([...result.output.bytes], [1, 2, 3]);
    assert.deepEqual(
      receivedPlan.transformations.filter((item) => item.type === "trim"),
      [{ type: "trim", options: { start: 0.51, end: 1.49 } }],
    );
    assert.deepEqual(state.events, ["workspace", "prepare-bytes", "cleanup"]);
  } finally {
    await client.dispose();
  }
});

test("missing trim features prevent direct execution before workspace creation", async () => {
  const state = fixture();
  state.plan.transformations = [{ type: "trim", options: { start: 0.51, end: 1.49 } }];

  await state.engine.initialize(context());

  try {
    const capabilities = await state.engine.capabilities();
    assert.equal(capabilities.operations.includes("trim"), false);

    await assert.rejects(state.engine.execute(state.plan, context()), {
      code: "UNSUPPORTED_CAPABILITY",
    });

    assert.deepEqual(state.events, []);
  } finally {
    await state.engine.dispose();
  }
});

test("native trim support rejects nonzero source origins", async () => {
  const state = fixture({ trim: true, origin: 1 });
  state.plan.transformations = [{ type: "trim", options: { start: 0.51, end: 1.49 } }];

  await state.engine.initialize(context());

  try {
    const metadata = await state.engine.probe(state.plan.input, context());
    const support = await state.engine.supports(state.plan, metadata);

    assert.equal(support.status, "unsupported");
    assert.equal(support.issues[0].code, "UNSUPPORTED_TIME_ORIGIN");
    assert.deepEqual(state.events, []);
  } finally {
    await state.engine.dispose();
  }
});

test("public empty trim preserves its error and cleans up without committing", async () => {
  const state = fixture({
    trim: true,
    prepare() {
      throw createMavioError("INVALID_OPTIONS", "No selected video frames.", {
        stage: "preparing",
        operation: "trim",
        details: {
          reason: "RANGE_TOO_SHORT",
          streamKind: "video",
        },
      });
    },
  });
  const client = createMavio({ engine: state.engine });

  try {
    await assert.rejects(
      client
        .from({ kind: "path", path: resolve("source.mp4") })
        .trim({ start: 0.001, end: 0.002 })
        .compress({ preset: "video-balanced-v1" })
        .export({ format: "mp4", output: { kind: "bytes" } }),
      (error) => {
        assert.equal(error.code, "INVALID_OPTIONS");
        assert.equal(error.details.reason, "RANGE_TOO_SHORT");
        assert.equal(error.details.streamKind, "video");
        return true;
      },
    );

    assert.deepEqual(state.events, ["workspace", "prepare-bytes", "cleanup"]);
  } finally {
    await client.dispose();
  }
});

test("public resize reaches preparation and returns resized metadata", async () => {
  let receivedPlan;
  const state = fixture({
    resize: true,
    outputDimensions: { width: 160, height: 90 },
    prepare(options) {
      receivedPlan = options.plan;
    },
  });
  const client = createMavio({ engine: state.engine });

  try {
    const capabilities = await client.capabilities();
    assert.ok(capabilities.operations.includes("resize"));
    assert.equal(capabilities.operations.includes("trim"), false);

    const result = await client
      .from({ kind: "path", path: resolve("source.mp4") })
      .resize({ width: 160, height: 90 })
      .compress({ preset: "video-balanced-v1" })
      .export({ format: "mp4", output: { kind: "bytes" } });

    assert.equal(result.metadata.streams[0].width, 160);
    assert.equal(result.metadata.streams[0].height, 90);
    assert.deepEqual(
      receivedPlan.transformations.filter((item) => item.type === "resize"),
      [{ type: "resize", options: { width: 160, height: 90 } }],
    );
    assert.deepEqual(state.events, ["workspace", "prepare-bytes", "cleanup"]);
  } finally {
    await client.dispose();
  }
});

test("missing resize filters prevent direct execution before workspace creation", async () => {
  const state = fixture();
  state.plan.transformations = [{ type: "resize", options: { width: 160, height: 90 } }];

  await state.engine.initialize(context());

  try {
    const capabilities = await state.engine.capabilities();
    assert.equal(capabilities.operations.includes("resize"), false);

    await assert.rejects(state.engine.execute(state.plan, context()), {
      code: "UNSUPPORTED_CAPABILITY",
    });

    assert.deepEqual(state.events, []);
  } finally {
    await state.engine.dispose();
  }
});

test("resize support rejects unsupported pixel geometry and orientation", async () => {
  for (const [hooks, reason] of [
    [{ sampleAspectRatio: "4:3" }, "UNSUPPORTED_RESIZE_SAMPLE_ASPECT_RATIO"],
    [{ defaultOrientation: false }, "UNSUPPORTED_RESIZE_ORIENTATION"],
  ]) {
    const state = fixture({ resize: true, ...hooks });
    state.plan.transformations = [{ type: "resize", options: { width: 160, height: 90 } }];

    await state.engine.initialize(context());

    try {
      const metadata = await state.engine.probe(state.plan.input, context());
      const support = await state.engine.supports(state.plan, metadata);

      assert.equal(support.status, "unsupported");
      assert.equal(support.issues[0].code, reason);
      assert.deepEqual(state.events, []);
    } finally {
      await state.engine.dispose();
    }
  }
});

test("public combined trim and resize preserves the requested plan", async () => {
  let receivedPlan;
  const state = fixture({
    trim: true,
    resize: true,
    outputDimensions: { width: 160, height: 90 },
    prepare(options) {
      receivedPlan = options.plan;
    },
  });
  const client = createMavio({ engine: state.engine });

  try {
    await client
      .from({ kind: "path", path: resolve("source.mp4") })
      .trim({ start: 0.51, end: 1.49 })
      .resize({ width: 160, height: 90 })
      .compress({ preset: "video-balanced-v1" })
      .export({ format: "mp4", output: { kind: "bytes" } });

    assert.deepEqual(
      receivedPlan.transformations.filter((item) => item.type === "trim" || item.type === "resize"),
      [
        { type: "trim", options: { start: 0.51, end: 1.49 } },
        { type: "resize", options: { width: 160, height: 90 } },
      ],
    );
  } finally {
    await client.dispose();
  }
});

test("native capabilities advertise both supported video presets", async () => {
  const state = fixture();
  const client = createMavio({ engine: state.engine });

  try {
    const capabilities = await client.capabilities();

    assert.deepEqual(
      capabilities.encodings.map((encoding) => encoding.preset),
      ["video-balanced-v1", "video-small-v1"],
    );
  } finally {
    await client.dispose();
  }
});

test("public small-preset export reaches preparation with the selected preset", async () => {
  let receivedPlan;
  const state = fixture({
    prepare(options) {
      receivedPlan = options.plan;
    },
  });
  const client = createMavio({ engine: state.engine });

  try {
    const result = await client
      .from({ kind: "path", path: resolve("source.mp4") })
      .compress({ preset: "video-small-v1" })
      .export({ format: "mp4", output: { kind: "bytes" } });

    assert.equal(receivedPlan.terminal.preset, "video-small-v1");
    assert.deepEqual(
      receivedPlan.transformations.filter((item) => item.type === "compress"),
      [{ type: "compress", options: { preset: "video-small-v1" } }],
    );
    assert.deepEqual([...result.output.bytes], [1, 2, 3]);
    assert.deepEqual(state.events, ["workspace", "prepare-bytes", "cleanup"]);
  } finally {
    await client.dispose();
  }
});

test("direct native execution rejects conflicting preset declarations", async () => {
  for (const [terminalPreset, declaredPreset] of [
    ["video-small-v1", "video-balanced-v1"],
    ["video-balanced-v1", "video-small-v1"],
  ]) {
    const state = fixture();
    state.plan.terminal.preset = terminalPreset;
    state.plan.transformations = [{ type: "compress", options: { preset: declaredPreset } }];

    await state.engine.initialize(context());

    try {
      await assert.rejects(state.engine.execute(state.plan, context()), {
        code: "UNSUPPORTED_CAPABILITY",
      });

      assert.deepEqual(state.events, []);
    } finally {
      await state.engine.dispose();
    }
  }
});

test("public small-preset export supports combined trim and resize routing", async () => {
  let receivedPlan;
  const state = fixture({
    trim: true,
    resize: true,
    outputDimensions: { width: 160, height: 90 },
    prepare(options) {
      receivedPlan = options.plan;
    },
  });
  const client = createMavio({ engine: state.engine });

  try {
    const result = await client
      .from({ kind: "path", path: resolve("source.mp4") })
      .trim({ start: 0.51, end: 1.49 })
      .resize({ width: 160, height: 90 })
      .compress({ preset: "video-small-v1" })
      .export({ format: "mp4", output: { kind: "bytes" } });

    assert.equal(receivedPlan.terminal.preset, "video-small-v1");
    assert.deepEqual(
      receivedPlan.transformations.map((item) => item.type),
      ["trim", "resize", "compress"],
    );
    assert.equal(result.metadata.streams[0].width, 160);
    assert.equal(result.metadata.streams[0].height, 90);
  } finally {
    await client.dispose();
  }
});
