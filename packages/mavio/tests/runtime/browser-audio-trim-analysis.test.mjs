import assert from "node:assert/strict";
import test from "node:test";
import { analyzeBrowserAudioTrim } from "../../dist/engines/browser/audio-trim-analysis.js";
import { buildBrowserAudioTrimPlan } from "../../dist/engines/browser/audio-trim-plan.js";

function report(channels = 2, samples = 24000) {
  const headers = [
    "#format: frame checksums",
    "#version: 2",
    "#hash: MD5",
    "#media_type 0: audio",
    "#codec_id 0: pcm_f32le",
  ];

  if (samples > 0) {
    headers.push(
      `0, 0, 0, ${samples}, ${samples * channels * 4}, ` + "0123456789abcdef0123456789abcdef",
    );
  }

  return headers;
}

function fixture(options = {}) {
  const listeners = new Set();
  const calls = [];
  const controller = new AbortController();

  const inventory = {
    encoders: ["pcm_f32le"],
    decoders: [],
    muxers: ["framemd5"],
    demuxers: [],
    filters: ["atrim", "asetpts"],
  };

  const worker = {
    loaded: true,
    terminations: 0,

    on(type, listener) {
      assert.equal(type, "log");
      listeners.add(listener);
    },

    off(type, listener) {
      assert.equal(type, "log");
      listeners.delete(listener);
    },

    terminate() {
      this.loaded = false;
      this.terminations += 1;
    },

    async exec(args) {
      calls.push(args);

      if (options.failure) throw options.failure;

      const emit = (type, message) => {
        for (const listener of listeners) {
          listener({ type, message });
        }
      };

      if (options.overflow) {
        emit("stdout", "x".repeat(1_048_576));
        return new Promise(() => {});
      }

      if (options.cancel) {
        controller.abort(new Error("Cancelled analysis."));
        return new Promise(() => {});
      }

      for (const line of options.lines ?? report(options.channels ?? 2, options.samples ?? 24000)) {
        emit("stdout", line);
      }

      if (options.stderr) emit("stderr", options.stderr);

      return options.exitCode ?? 0;
    },
  };

  const analysis = {
    inputPath: "/mavio-test/input.bin",
    streamIndex: 3,
    channels: options.channels ?? 2,
    filters: buildBrowserAudioTrimPlan(
      [{ type: "trim", options: { start: 0.125, end: 0.625 } }],
      1,
      0,
      inventory,
    ),
    inventory,
  };

  const context = {
    jobId: "browser-audio-trim-analysis-test",
    signal: controller.signal,
    reportProgress() {},
  };

  return {
    worker,
    analysis,
    context,
    calls,
    listeners,
    controller,
  };
}

function analyze(value) {
  return analyzeBrowserAudioTrim(value.worker, value.analysis, value.context);
}

test("browser audio analysis counts sample frames per channel and maps the selected stream", async () => {
  for (const channels of [1, 2]) {
    const value = fixture({ channels });
    const result = await analyze(value);

    assert.deepEqual(result, { audioSamples: 24000 });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(value.listeners.size, 0);

    const args = value.calls[0];

    assert.equal(args[args.indexOf("-map") + 1], "0:3");
    assert.equal(args[args.indexOf("-af") + 1], value.analysis.filters.audio);
    assert.equal(args.includes("-copyts"), true);
    assert.equal(args.includes("-n"), false);
    assert.equal(args.at(-1), "pipe:1");
  }
});

test("browser audio analysis rejects empty selection", async () => {
  const value = fixture({ samples: 0 });

  await assert.rejects(analyze(value), {
    code: "INVALID_OPTIONS",
    operation: "trim",
    details: {
      reason: "RANGE_TOO_SHORT",
      streamKind: "audio",
    },
  });

  assert.equal(value.listeners.size, 0);
});

test("browser audio analysis validates paths, indices and channels before worker access", async () => {
  for (const change of [
    { inputPath: "/outside/input.bin" },
    { streamIndex: -1 },
    { streamIndex: 0.5 },
    { channels: 3 },
  ]) {
    const value = fixture();
    Object.assign(value.analysis, change);

    await assert.rejects(analyze(value), {
      code: "INVALID_OPTIONS",
      details: { reason: "INVALID_TRIM_ANALYSIS_OPTIONS" },
    });

    assert.equal(value.calls.length, 0);
    assert.equal(value.listeners.size, 0);
  }
});

test("browser audio analysis requires checksum muxing and float PCM encoding", async () => {
  for (const [field, feature] of [
    ["muxers", "framemd5"],
    ["encoders", "pcm_f32le"],
  ]) {
    const value = fixture();
    value.analysis.inventory[field] = [];

    await assert.rejects(analyze(value), {
      code: "UNSUPPORTED_CAPABILITY",
      details: {
        reason: "MISSING_TRIM_ANALYSIS_FEATURE",
        feature,
      },
    });

    assert.equal(value.calls.length, 0);
  }
});

test("browser audio analysis requires a successful exit without error diagnostics", async () => {
  for (const options of [{ exitCode: 1 }, { exitCode: -1 }, { stderr: "Decoder error." }]) {
    const value = fixture(options);

    await assert.rejects(analyze(value), {
      code: "EXECUTION_FAILED",
    });

    assert.equal(value.listeners.size, 0);
  }

  const marker = fixture({ stderr: "Aborted()" });

  assert.deepEqual(await analyze(marker), { audioSamples: 24000 });
});

test("browser audio analysis rejects malformed evidence and preserves worker failure causes", async () => {
  const malformed = fixture({ lines: ["not a checksum report"] });

  await assert.rejects(analyze(malformed), {
    code: "EXECUTION_FAILED",
    details: { reason: "INVALID_TRIM_SELECTION" },
  });

  const failure = new Error("Worker trapped.");
  const value = fixture({ failure });

  await assert.rejects(analyze(value), (error) => {
    assert.equal(error.code, "EXECUTION_FAILED");
    assert.equal(error.cause, failure);
    return true;
  });

  assert.equal(value.listeners.size, 0);
});

test("browser audio analysis bounds reports and terminates pending execution on overflow", async () => {
  const value = fixture({ overflow: true });

  await assert.rejects(analyze(value), {
    code: "RESOURCE_LIMIT",
    details: {
      reason: "TRIM_ANALYSIS_OUTPUT_LIMIT",
      limitBytes: 1_048_576,
    },
  });

  assert.equal(value.worker.terminations, 1);
  assert.equal(value.listeners.size, 0);
});

test("browser audio analysis handles pre-admission and active cancellation", async () => {
  const before = fixture();
  before.controller.abort();

  await assert.rejects(analyze(before), { code: "CANCELLED" });

  assert.equal(before.calls.length, 0);
  assert.equal(before.worker.terminations, 0);
  assert.equal(before.listeners.size, 0);

  const active = fixture({ cancel: true });

  await assert.rejects(analyze(active), { code: "CANCELLED" });

  assert.equal(active.worker.terminations, 1);
  assert.equal(active.listeners.size, 0);
});
