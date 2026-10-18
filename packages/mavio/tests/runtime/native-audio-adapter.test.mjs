import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createNativeEngine } from "../../dist/engines/native/adapter.js";

function fixture({
  encoders = ["libmp3lame", "pcm_s16le"],
  muxers = ["mp3", "wav"],
  cleanupFails = false,
  filters = [],
} = {}) {
  const events = [];
  const controller = new AbortController();

  const source = {
    formatStartTimeSeconds: 0,
    metadata: {
      durationSeconds: 1,
      streams: [
        { index: 0, kind: "video", rotationDegrees: 90 },
        { index: 4, kind: "audio", sampleRate: 48000, channels: 2 },
      ],
    },
    streams: [{ index: 0 }, { index: 4, channelLayout: "stereo" }],
  };

  function metadata(preset) {
    return {
      container: preset === "audio-balanced-v1" ? "mp3" : "wav",
      durationSeconds: 1,
      sizeBytes: 3,
      streams: [
        {
          index: 0,
          kind: "audio",
          codec: preset === "audio-balanced-v1" ? "mp3" : "pcm_s16le",
          sampleRate: 48000,
          channels: 2,
        },
      ],
    };
  }

  const workspace = {
    async writeInput() {
      return resolve("staged input.bin");
    },
    getOutputPath() {
      return resolve("staged output.bin");
    },
    async readOutput() {
      assert.fail("Mock preparation supplies the bytes.");
    },
    async dispose() {
      events.push("cleanup");
      if (cleanupFails) throw new Error("Cleanup failed");
    },
  };

  const context = {
    jobId: "audio-adapter-test",
    signal: controller.signal,
    reportProgress() {},
    beginCommit() {
      events.push("commit");
      return true;
    },
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
          encoders,
          muxers,
          decoders: [],
          demuxers: [],
          filters,
        };
      },
      async probeDetails() {
        return source;
      },
      async workspace() {
        return workspace;
      },
      async pathWorkspace() {
        return workspace;
      },
      async prepareBytes() {
        assert.fail("Audio must not use video preparation.");
      },
      async prepareFile() {
        assert.fail("Audio must not use video preparation.");
      },
      async prepareAudioBytes({ plan }) {
        events.push("prepare-bytes");
        return {
          bytes: new Uint8Array([1, 2, 3]),
          metadata: metadata(plan.terminal.preset),
        };
      },
      async prepareAudioFile({ plan }) {
        events.push("prepare-file");
        return {
          path: workspace.getOutputPath(),
          metadata: metadata(plan.terminal.preset),
        };
      },
      async publish(staged, target, ctx) {
        assert.equal(staged, workspace.getOutputPath());
        assert.equal(target, resolve("published audio.wav"));
        assert.equal(ctx.beginCommit(), true);
        events.push("publish");
      },
    },
  );

  function plan(preset = "audio-balanced-v1") {
    return {
      input: { kind: "path", path: resolve("source.flac") },
      transformations: [{ type: "extractAudio", options: { streamIndex: 4 } }],
      terminal: {
        type: "export",
        format: preset === "audio-balanced-v1" ? "mp3" : "wav",
        preset,
      },
      output: { kind: "bytes" },
    };
  }

  return { engine, context, events, plan, source };
}

test("audio capabilities are available independently of video encoders", async () => {
  for (const [encoder, muxer, preset] of [
    ["libmp3lame", "mp3", "audio-balanced-v1"],
    ["pcm_s16le", "wav", "audio-pcm-v1"],
  ]) {
    const f = fixture({ encoders: [encoder], muxers: [muxer] });
    await f.engine.initialize(f.context);

    const capabilities = await f.engine.capabilities();

    assert.deepEqual(
      capabilities.encodings.map((item) => item.preset),
      [preset],
    );
    assert.ok(capabilities.operations.includes("extractAudio"));
    assert.deepEqual(capabilities.outputKinds, ["bytes", "path"]);

    await f.engine.dispose();
  }
});

test("missing audio components prevent advertising and executing the preset", async () => {
  for (const settings of [
    { encoders: [], muxers: ["mp3"] },
    { encoders: ["libmp3lame"], muxers: [] },
  ]) {
    const f = fixture(settings);
    await f.engine.initialize(f.context);

    const capabilities = await f.engine.capabilities();
    assert.deepEqual(capabilities.encodings, []);

    await assert.rejects(f.engine.execute(f.plan(), f.context), { code: "UNSUPPORTED_CAPABILITY" });

    assert.deepEqual(f.events, []);
    await f.engine.dispose();
  }
});

test("both audio byte routes clean up before granting publication", async () => {
  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    const f = fixture();
    await f.engine.initialize(f.context);

    const result = await f.engine.execute(f.plan(preset), f.context);

    assert.equal(result.output.kind, "bytes");
    assert.deepEqual(result.output.bytes, new Uint8Array([1, 2, 3]));
    assert.deepEqual(f.events, ["prepare-bytes", "cleanup", "commit"]);

    await f.engine.dispose();
  }
});

test("audio support ignores unused video orientation and rejects pending trim", async () => {
  const f = fixture();
  await f.engine.initialize(f.context);

  const plan = f.plan();
  const source = await f.engine.probe(plan.input, f.context);

  assert.equal((await f.engine.supports(plan, source)).status, "supported");

  plan.transformations.unshift({
    type: "trim",
    options: { start: 0, end: 0.5 },
  });

  assert.equal((await f.engine.supports(plan, source)).status, "unsupported");

  await assert.rejects(f.engine.execute(plan, f.context), { code: "UNSUPPORTED_CAPABILITY" });

  assert.deepEqual(f.events, []);
  await f.engine.dispose();
});

test("audio byte cleanup failure prevents publication", async () => {
  const f = fixture({ cleanupFails: true });
  await f.engine.initialize(f.context);

  await assert.rejects(f.engine.execute(f.plan(), f.context), { code: "CLEANUP_FAILED" });

  assert.deepEqual(f.events, ["prepare-bytes", "cleanup"]);

  await assert.rejects(f.engine.dispose(), { code: "CLEANUP_FAILED" });
});

test("audio path export uses the existing publication and cleanup sequence", async () => {
  const f = fixture();
  await f.engine.initialize(f.context);

  const plan = f.plan("audio-pcm-v1");
  plan.output = { kind: "path", path: resolve("published audio.wav") };

  const result = await f.engine.execute(plan, f.context);

  assert.deepEqual(result.output, plan.output);
  assert.deepEqual(f.events, ["prepare-file", "commit", "publish", "cleanup"]);

  await f.engine.dispose();
});

function audioTrimFixture(overrides = {}) {
  return fixture({
    encoders: ["libmp3lame", "pcm_s16le", "pcm_f32le"],
    muxers: ["mp3", "wav", "framemd5"],
    filters: ["atrim", "asetpts"],
    ...overrides,
  });
}

test("audio trim is supported without video encoders or filters", async () => {
  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    const f = audioTrimFixture();
    await f.engine.initialize(f.context);

    const capabilities = await f.engine.capabilities();
    assert.ok(capabilities.operations.includes("trim"));
    assert.equal(
      capabilities.encodings.some((encoding) => encoding.container === "mp4"),
      false,
    );

    const plan = f.plan(preset);
    plan.transformations.unshift({
      type: "trim",
      options: { start: 0.25, end: 0.75 },
    });

    const source = await f.engine.probe(plan.input, f.context);
    assert.equal((await f.engine.supports(plan, source)).status, "supported");

    const result = await f.engine.execute(plan, f.context);
    assert.equal(result.output.kind, "bytes");
    assert.deepEqual(f.events, ["prepare-bytes", "cleanup", "commit"]);

    await f.engine.dispose();
  }
});

test("audio trim requires every analysis component while ordinary export remains available", async () => {
  for (const overrides of [
    { encoders: ["libmp3lame", "pcm_s16le"] },
    { muxers: ["mp3", "wav"] },
    { filters: ["atrim"] },
    { filters: ["asetpts"] },
  ]) {
    const f = audioTrimFixture(overrides);
    await f.engine.initialize(f.context);

    const capabilities = await f.engine.capabilities();
    assert.equal(capabilities.operations.includes("trim"), false);

    const plan = f.plan();
    const source = await f.engine.probe(plan.input, f.context);

    assert.equal((await f.engine.supports(plan, source)).status, "supported");

    plan.transformations.unshift({
      type: "trim",
      options: { start: 0.25, end: 0.75 },
    });

    assert.equal((await f.engine.supports(plan, source)).status, "unsupported");

    await assert.rejects(f.engine.execute(plan, f.context), { code: "UNSUPPORTED_CAPABILITY" });

    assert.deepEqual(f.events, []);
    await f.engine.dispose();
  }
});

test("audio trim routing allows consecutive trims around extraction", async () => {
  const f = audioTrimFixture();
  await f.engine.initialize(f.context);

  const plan = f.plan();
  plan.transformations = [
    { type: "trim", options: { start: 0, end: 0.75 } },
    { type: "extractAudio", options: { streamIndex: 4 } },
    { type: "trim", options: { start: 0.25, end: 0.5 } },
  ];

  const source = await f.engine.probe(plan.input, f.context);
  assert.equal((await f.engine.supports(plan, source)).status, "supported");

  await f.engine.execute(plan, f.context);
  assert.deepEqual(f.events, ["prepare-bytes", "cleanup", "commit"]);

  await f.engine.dispose();
});

test("audio trim support rejects unsupported source timing", async () => {
  for (const origin of [undefined, 0.023021]) {
    const f = audioTrimFixture();
    f.source.formatStartTimeSeconds = origin;
    await f.engine.initialize(f.context);

    const plan = f.plan();
    plan.transformations.unshift({
      type: "trim",
      options: { start: 0.25, end: 0.75 },
    });

    const source = await f.engine.probe(plan.input, f.context);
    const support = await f.engine.supports(plan, source);

    assert.equal(support.status, "unsupported");
    assert.equal(support.issues[0].code, "UNSUPPORTED_TIME_ORIGIN");
    assert.deepEqual(f.events, []);

    await f.engine.dispose();
  }
});
