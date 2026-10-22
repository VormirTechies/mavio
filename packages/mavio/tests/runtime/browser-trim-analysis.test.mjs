import assert from "node:assert/strict";
import test from "node:test";
import { analyzeBrowserTrimSelection } from "../../dist/engines/browser/trim-analysis.js";
import { buildBrowserTrimPlan } from "../../dist/engines/browser/trim-plan.js";

const hash = "0123456789abcdef0123456789abcdef";

function videoReport(empty = false) {
  return [
    "#format: frame checksums",
    "#version: 2",
    "#hash: MD5",
    "#media_type 0: video",
    "#codec_id 0: rawvideo",
    ...(empty ? [] : [`0, 0, 0, 1, 64, ${hash}`, `0, 1, 1, 1, 64, ${hash}`]),
  ].join("\n");
}

function fixture(settings = {}) {
  const listeners = new Set();
  const calls = [];
  const files = new Map();

  let started;

  const entered = new Promise((resolve) => {
    started = resolve;
  });

  const inventory = {
    encoders: ["rawvideo", "pcm_f32le"],
    decoders: [],
    muxers: ["framemd5", "f32le"],
    demuxers: [],
    filters: ["trim", "settb", "setpts", "atrim", "asetpts"],
  };

  const hasAudio = settings.hasAudio ?? true;
  const channels = settings.channels ?? 1;

  const options = {
    inputPath: "/mavio-analysis/input.bin",
    videoStreamIndex: 2,
    ...(hasAudio
      ? {
          audio: {
            streamIndex: 5,
            channels,
          },
        }
      : {}),
    filters: buildBrowserTrimPlan(
      [
        {
          type: "trim",
          options: {
            start: 0.125,
            end: 0.75,
          },
        },
      ],
      1,
      0,
      hasAudio,
      inventory,
    ),
    inventory,
  };

  const worker = {
    loaded: true,
    terminations: 0,

    on(_event, callback) {
      listeners.add(callback);
    },

    off(_event, callback) {
      listeners.delete(callback);
    },

    async listDir() {
      return [...files.keys()].map((path) => ({
        name: path.slice(path.lastIndexOf("/") + 1),
        isDir: false,
      }));
    },

    async readFile(path) {
      if (settings.readFailure) {
        throw new Error("PCM read failed.");
      }

      if (!files.has(path)) {
        throw new Error("Missing PCM output.");
      }

      return files.get(path);
    },

    async deleteFile(path) {
      if (settings.deleteFailure) {
        throw new Error("PCM cleanup failed.");
      }

      files.delete(path);
    },

    async exec(args) {
      calls.push(args);
      started();

      if (settings.stall) {
        return new Promise(() => {});
      }

      const isVideo = args.includes("-an");

      if (isVideo) {
        const text = settings.overflow
          ? "x".repeat(1_048_577)
          : settings.malformed
            ? "not a frame report"
            : videoReport(settings.emptyVideo);

        for (const callback of listeners) {
          callback({
            type: "stdout",
            message: text,
          });
        }
      } else {
        const sampleFrames = settings.emptyAudio ? 0 : 1040;

        files.set(args.at(-1), settings.pcmBytes ?? new Uint8Array(sampleFrames * 4 * channels));
      }

      for (const message of settings.logs ?? ["Aborted()"]) {
        for (const callback of listeners) {
          callback({
            type: "stderr",
            message,
          });
        }
      }

      return settings.exitCode ?? 0;
    },

    terminate() {
      this.loaded = false;
      this.terminations += 1;
      files.clear();
    },
  };

  return {
    worker,
    options,
    listeners,
    calls,
    files,
    entered,
  };
}

function context(controller = new AbortController()) {
  return {
    jobId: "browser-trim-analysis-test",
    signal: controller.signal,
    reportProgress() {},
  };
}

test("browser trim analysis counts video and raw PCM sample frames", async () => {
  const value = fixture();

  const result = await analyzeBrowserTrimSelection(value.worker, value.options, context());

  assert.deepEqual(result, {
    videoFrames: 2,
    audioSamples: 1040,
  });

  assert.equal(Object.isFrozen(result), true);
  assert.equal(value.calls.length, 2);
  assert.ok(value.calls[0].includes("0:2"));
  assert.ok(value.calls[1].includes("0:5"));

  const audioCommand = value.calls[1];

  assert.equal(audioCommand[audioCommand.indexOf("-f") + 1], "f32le");

  assert.equal(audioCommand[audioCommand.indexOf("-fs") + 1], String(64 * 1024 * 1024));

  assert.equal(audioCommand.includes("framemd5"), false);
  assert.equal(audioCommand.includes("pipe:1"), false);
  assert.equal(value.files.size, 0);
  assert.equal(value.listeners.size, 0);
});

test("stereo PCM counts sample frames rather than individual channel samples", async () => {
  const value = fixture({ channels: 2 });

  const result = await analyzeBrowserTrimSelection(value.worker, value.options, context());

  assert.deepEqual(result, {
    videoFrames: 2,
    audioSamples: 1040,
  });

  assert.equal(value.files.size, 0);
});

test("video-only analysis does not require PCM features", async () => {
  const value = fixture({ hasAudio: false });

  value.options.inventory.encoders = ["rawvideo"];
  value.options.inventory.muxers = ["framemd5"];

  const result = await analyzeBrowserTrimSelection(value.worker, value.options, context());

  assert.deepEqual(result, {
    videoFrames: 2,
  });

  assert.equal(value.calls.length, 1);
  assert.equal(value.files.size, 0);
});

test("empty video rejects before audio analysis and permits same-worker recovery", async () => {
  const settings = { emptyVideo: true };
  const value = fixture(settings);

  await assert.rejects(
    analyzeBrowserTrimSelection(value.worker, value.options, context()),
    (error) => {
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.stage, "preparing");
      assert.equal(error.operation, "trim");
      assert.equal(error.jobId, "browser-trim-analysis-test");
      assert.equal(error.details.reason, "RANGE_TOO_SHORT");
      assert.equal(error.details.streamKind, "video");
      return true;
    },
  );

  assert.equal(value.calls.length, 1);
  assert.ok(value.calls[0].includes("-an"));
  assert.equal(value.files.size, 0);
  assert.equal(value.listeners.size, 0);
  assert.equal(value.worker.terminations, 0);

  settings.emptyVideo = false;

  const recovered = await analyzeBrowserTrimSelection(value.worker, value.options, context());

  assert.deepEqual(recovered, {
    videoFrames: 2,
    audioSamples: 1040,
  });

  assert.equal(value.calls.length, 3);
  assert.equal(value.files.size, 0);
  assert.equal(value.listeners.size, 0);
  assert.equal(value.worker.terminations, 0);
});

test("empty required audio rejects after deleting its temporary output", async () => {
  const value = fixture({ emptyAudio: true });

  await assert.rejects(
    analyzeBrowserTrimSelection(value.worker, value.options, context()),
    (error) => {
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.details.reason, "RANGE_TOO_SHORT");
      assert.equal(error.details.streamKind, "audio");
      return true;
    },
  );

  assert.equal(value.files.size, 0);
  assert.equal(value.listeners.size, 0);
});

test("malformed video reports remain execution failures", async () => {
  const value = fixture({ malformed: true });

  await assert.rejects(analyzeBrowserTrimSelection(value.worker, value.options, context()), {
    code: "EXECUTION_FAILED",
  });

  assert.equal(value.calls.length, 1);
  assert.equal(value.listeners.size, 0);
});

test("incomplete PCM samples reject and clean up", async () => {
  const value = fixture({
    pcmBytes: new Uint8Array(3),
  });

  await assert.rejects(analyzeBrowserTrimSelection(value.worker, value.options, context()), {
    code: "EXECUTION_FAILED",
    details: {
      reason: "INVALID_TRIM_AUDIO_PCM",
    },
  });

  assert.equal(value.files.size, 0);
  assert.equal(value.listeners.size, 0);
});

test("PCM at the output limit rejects rather than accepting a truncated count", async () => {
  const value = fixture({
    pcmBytes: new Uint8Array(64 * 1024 * 1024),
  });

  await assert.rejects(analyzeBrowserTrimSelection(value.worker, value.options, context()), {
    code: "RESOURCE_LIMIT",
    details: {
      reason: "TRIM_AUDIO_OUTPUT_LIMIT",
      limitBytes: 64 * 1024 * 1024,
    },
  });

  assert.equal(value.files.size, 0);
});

test("PCM read failure preserves its cause and removes output", async () => {
  const value = fixture({
    readFailure: true,
  });

  await assert.rejects(
    analyzeBrowserTrimSelection(value.worker, value.options, context()),
    (error) => {
      assert.equal(error.code, "EXECUTION_FAILED");
      assert.equal(error.cause.message, "PCM read failed.");
      return true;
    },
  );

  assert.equal(value.files.size, 0);
  assert.equal(value.listeners.size, 0);
});

test("cleanup failure rejects otherwise successful audio analysis", async () => {
  const value = fixture({
    deleteFailure: true,
  });

  await assert.rejects(analyzeBrowserTrimSelection(value.worker, value.options, context()), {
    code: "CLEANUP_FAILED",
    details: {
      reason: "AUDIO_ANALYSIS_CLEANUP_FAILED",
    },
  });

  assert.equal(value.listeners.size, 0);
});

test("cleanup diagnostics preserve the primary PCM read failure", async () => {
  const value = fixture({
    readFailure: true,
    deleteFailure: true,
  });

  await assert.rejects(
    analyzeBrowserTrimSelection(value.worker, value.options, context()),
    (error) => {
      assert.equal(error.code, "EXECUTION_FAILED");
      assert.equal(error.cause.message, "PCM read failed.");
      assert.ok(error.cleanupIssues.some((message) => message.includes("PCM cleanup failed.")));
      return true;
    },
  );
});

test("analysis requires zero exit and rejects genuine diagnostics", async () => {
  for (const settings of [
    { exitCode: 1 },
    { exitCode: -1 },
    { logs: ["Decoder error."] },
    { logs: ["Aborted(out of memory)"] },
  ]) {
    const value = fixture(settings);

    await assert.rejects(analyzeBrowserTrimSelection(value.worker, value.options, context()), {
      code: "EXECUTION_FAILED",
    });

    assert.equal(value.listeners.size, 0);
  }
});

test("analysis log overflow stops the worker and removes listeners", async () => {
  const value = fixture({ overflow: true });

  await assert.rejects(analyzeBrowserTrimSelection(value.worker, value.options, context()), {
    code: "RESOURCE_LIMIT",
    details: {
      reason: "TRIM_ANALYSIS_OUTPUT_LIMIT",
    },
  });

  assert.equal(value.worker.terminations, 1);
  assert.equal(value.listeners.size, 0);
});

test("cancellation interrupts stalled selection analysis", async () => {
  const value = fixture({ stall: true });
  const controller = new AbortController();

  const pending = analyzeBrowserTrimSelection(value.worker, value.options, context(controller));

  const rejected = assert.rejects(pending, {
    code: "CANCELLED",
  });

  await value.entered;
  controller.abort();
  await rejected;

  assert.equal(value.worker.terminations, 1);
  assert.equal(value.listeners.size, 0);
});

test("invalid options and missing features reject before execution", async () => {
  for (const modify of [
    (value) => {
      value.options.inputPath = "../outside";
    },
    (value) => {
      value.options.videoStreamIndex = -1;
    },
    (value) => {
      value.options.audio.channels = 3;
    },
    (value) => {
      value.options.inventory.muxers = [];
    },
    (value) => {
      value.options.inventory.encoders = ["rawvideo"];
    },
    (value) => {
      value.options.inventory.muxers = ["framemd5"];
    },
  ]) {
    const value = fixture();
    modify(value);

    await assert.rejects(analyzeBrowserTrimSelection(value.worker, value.options, context()));

    assert.equal(value.calls.length, 0);
    assert.equal(value.files.size, 0);
  }
});
