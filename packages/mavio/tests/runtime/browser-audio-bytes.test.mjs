import assert from "node:assert/strict";
import test from "node:test";
import { prepareBrowserAudioBytes } from "../../dist/engines/browser/audio-bytes.js";
import { createMavioError } from "../../dist/core/errors.js";

function fixture(options = {}) {
  const preset = options.preset ?? "audio-balanced-v1";
  const pcm = preset === "audio-pcm-v1";
  const format = pcm ? "wav" : "mp3";

  const files = new Map();
  const directories = new Set();
  const calls = [];
  const controller = new AbortController();
  const stages = [];

  const encoded = new Uint8Array(pcm ? 76 : 384);

  if (pcm) {
    const view = new DataView(encoded.buffer);
    const text = (offset, value) => {
      encoded.set(new TextEncoder().encode(value), offset);
    };

    text(0, "RIFF");
    view.setUint32(4, encoded.length - 8, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, 48000, true);
    view.setUint32(28, 192000, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, 32, true);
  } else {
    encoded.set([0xff, 0xfb, 0x94, 0]);
  }

  function report(output) {
    return {
      format: {
        format_name: output ? format : "wav",
        duration: "0.1",
        size: String(output ? encoded.length : 3),
      },
      streams: [
        {
          index: options.streamIndex ?? 0,
          codec_type: "audio",
          codec_name: output && !pcm ? "mp3" : "pcm_s16le",
          sample_rate: "48000",
          channels: 2,
          channel_layout: "stereo",
        },
      ],
    };
  }

  const worker = {
    loaded: true,
    terminations: 0,

    async createDir(path) {
      calls.push("mkdir");
      directories.add(path);
      return true;
    },

    async listDir(path) {
      assert.equal(directories.has(path), true);

      return [...files.keys()]
        .filter((name) => name.startsWith(`${path}/`))
        .map((name) => ({
          name: name.slice(path.length + 1),
          isDir: false,
        }));
    },

    async writeFile(path, bytes) {
      calls.push("write");

      // Simulate the wrapper transferring ownership of its input buffer.
      files.set(path, structuredClone(bytes, { transfer: [bytes.buffer] }));

      return true;
    },

    async ffprobe(args) {
      const outputIndex = args.indexOf("-o");
      const inputPath = args[outputIndex - 1];
      const probePath = args[outputIndex + 1];
      const output = inputPath.endsWith(`/output.${format}`);

      calls.push(output ? "probe-output" : "probe-input");

      files.set(
        probePath,
        options.invalidProbe && output ? "{invalid" : JSON.stringify(report(output)),
      );

      return -1;
    },

    async readFile(path) {
      if (path.endsWith(`/output.${format}`)) {
        calls.push("read-output");

        if (options.stallRead) {
          controller.abort(new Error("Cancelled output read."));
          return new Promise(() => {});
        }

        if (options.textOutput) return "unexpected text";
      }

      if (!files.has(path)) throw new Error("Missing file.");

      return files.get(path);
    },

    async deleteFile(path) {
      if (options.failCleanup && path.endsWith("/input.bin")) {
        throw new Error("Cleanup failed.");
      }

      files.delete(path);
      return true;
    },

    async deleteDir(path) {
      calls.push("cleanup");
      directories.delete(path);
      return true;
    },

    terminate() {
      this.terminations += 1;
      this.loaded = false;
      files.clear();
      directories.clear();
    },
  };

  const input = new Uint8Array([1, 2, 3]);

  const plan = {
    input: { kind: "bytes", bytes: input },
    transformations: [],
    terminal: { type: "export", format, preset },
    output: { kind: "bytes" },
  };

  const context = {
    jobId: "browser-audio-bytes-test",
    signal: controller.signal,
    reportProgress(event) {
      stages.push(event.stage);
    },
    beginCommit() {
      throw new Error("Preparation must not publish.");
    },
  };

  const inventory = {
    encoders: ["libmp3lame", "pcm_s16le"],
    decoders: ["pcm_s16le", "mp3"],
    muxers: ["mp3", "wav"],
    demuxers: ["mp3", "wav"],
    filters: [],
  };

  const dependencies = {
    async execute(_worker, command) {
      calls.push("encode");

      if (options.executionFailure) {
        throw options.executionFailure;
      }

      if (options.badSignature) encoded[0] = 0;

      files.set(command.outputPath, encoded);
    },
  };

  return {
    worker,
    plan,
    context,
    inventory,
    dependencies,
    controller,
    input,
    encoded,
    calls,
    stages,
    files,
    directories,
  };
}

function prepare(value) {
  return prepareBrowserAudioBytes(
    value.worker,
    value.plan,
    value.inventory,
    value.context,
    value.dependencies,
  );
}

test("audio preparation validates both presets and returns owned bytes after cleanup", async () => {
  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    const value = fixture({ preset });
    const result = await prepare(value);
    const snapshot = result.bytes.slice();

    assert.equal(result.metadata.container, preset === "audio-pcm-v1" ? "wav" : "mp3");
    assert.deepEqual(value.stages, ["running", "finalizing"]);
    assert.deepEqual(value.calls, [
      "mkdir",
      "write",
      "probe-input",
      "encode",
      "probe-output",
      "read-output",
      "cleanup",
    ]);

    assert.equal(value.files.size, 0);
    assert.equal(value.directories.size, 0);
    assert.equal(value.worker.terminations, 0);
    assert.deepEqual(value.input, new Uint8Array([1, 2, 3]));

    value.encoded.fill(0);
    value.worker.terminate();

    assert.deepEqual(result.bytes, snapshot);
  }
});

test("audio preparation accepts Blob input without modifying it", async () => {
  const value = fixture();
  const blob = new Blob([value.input]);
  value.plan.input = { kind: "blob", blob };

  await prepare(value);

  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

test("audio preparation honors an explicit absolute audio stream index", async () => {
  const value = fixture({ streamIndex: 3 });

  value.plan.transformations = [{ type: "extractAudio", options: { streamIndex: 3 } }];

  await prepare(value);

  assert.equal(value.calls.includes("encode"), true);

  const invalid = fixture({ streamIndex: 3 });
  invalid.plan.transformations = [{ type: "extractAudio", options: { streamIndex: 1 } }];

  await assert.rejects(prepare(invalid), {
    code: "INVALID_OPTIONS",
    details: { reason: "INVALID_STREAM_INDEX" },
  });

  assert.equal(invalid.calls.includes("encode"), false);
  assert.equal(invalid.worker.terminations, 1);
});

test("audio preparation validates the command before injected execution", async () => {
  const value = fixture();
  value.plan.terminal.format = "wav";

  await assert.rejects(prepare(value), {
    code: "INVALID_OPTIONS",
    details: { reason: "TERMINAL_FORMAT_MISMATCH" },
  });

  assert.equal(value.calls.includes("encode"), false);
  assert.equal(value.files.size, 0);
  assert.equal(value.worker.terminations, 1);
});

test("audio preparation preserves execution failure as its cause", async () => {
  const failure = new Error("Encoder trapped.");
  const value = fixture({ executionFailure: failure });

  await assert.rejects(prepare(value), (error) => {
    assert.equal(error.code, "EXECUTION_FAILED");
    assert.equal(error.stage, "running");
    assert.equal(error.cause, failure);
    return true;
  });

  assert.equal(value.worker.terminations, 1);
  assert.equal(value.files.size, 0);
  assert.equal(value.directories.size, 0);
});

test("audio preparation rejects invalid output probes, signatures and text output", async () => {
  for (const options of [{ invalidProbe: true }, { badSignature: true }, { textOutput: true }]) {
    const value = fixture(options);

    await assert.rejects(prepare(value), {
      code: "EXECUTION_FAILED",
      stage: "finalizing",
    });

    assert.equal(value.worker.terminations, 1);
    assert.equal(value.files.size, 0);
  }
});

test("audio preparation rejects cleanup failure instead of returning output", async () => {
  const value = fixture({ failCleanup: true });

  await assert.rejects(prepare(value), {
    code: "CLEANUP_FAILED",
    stage: "finalizing",
  });

  assert.equal(value.worker.terminations, 1);
  assert.equal(value.files.size, 0);
  assert.equal(value.directories.size, 0);
});

test("pre-admission cancellation leaves the worker untouched", async () => {
  const value = fixture();
  value.controller.abort();

  await assert.rejects(prepare(value), { code: "CANCELLED" });

  assert.deepEqual(value.calls, []);
  assert.equal(value.worker.terminations, 0);
  assert.equal(value.worker.loaded, true);
});

test("cancellation interrupts a stalled output read and releases staging", async () => {
  const value = fixture({ stallRead: true });

  await assert.rejects(prepare(value), { code: "CANCELLED" });

  assert.equal(value.worker.terminations, 1);
  assert.equal(value.files.size, 0);
  assert.equal(value.directories.size, 0);
});

function trimmedPreparation(options = {}) {
  const value = fixture(options);
  const analyses = [];

  value.inventory.filters = ["atrim", "asetpts"];

  value.plan.transformations = [
    {
      type: "trim",
      options: { start: 0.025, end: 0.075 },
    },
  ];

  value.dependencies.analyze = async (_worker, analysis) => {
    value.calls.push("analyze");
    analyses.push(analysis);

    assert.equal(
      [...value.files.keys()].some(
        (path) => path.endsWith("/output.mp3") || path.endsWith("/output.wav"),
      ),
      false,
      "Analysis must precede output creation.",
    );

    return { audioSamples: 2400 };
  };

  return { ...value, analyses };
}

test("both audio presets analyze trim before encoding and clean staging", async () => {
  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    const value = trimmedPreparation({ preset });
    const result = await prepare(value);

    assert.deepEqual(value.calls, [
      "mkdir",
      "write",
      "probe-input",
      "analyze",
      "encode",
      "probe-output",
      "read-output",
      "cleanup",
    ]);

    assert.equal(value.analyses.length, 1);

    assert.deepEqual(value.analyses[0].filters.range, {
      startSeconds: 0.025,
      endSeconds: 0.075,
    });

    assert.equal(value.files.size, 0);
    assert.equal(value.directories.size, 0);
    assert.equal(value.worker.terminations, 0);

    const snapshot = result.bytes.slice();
    value.encoded.fill(0);

    assert.deepEqual(result.bytes, snapshot);
    assert.deepEqual(value.input, new Uint8Array([1, 2, 3]));
  }
});

test("consecutive audio trims analyze the resolved source interval once", async () => {
  const value = trimmedPreparation();

  value.plan.transformations = [
    {
      type: "trim",
      options: { start: 0.0125, end: 0.0875 },
    },
    {
      type: "trim",
      options: { start: 0.0125, end: 0.0625 },
    },
  ];

  await prepare(value);

  assert.equal(value.analyses.length, 1);

  assert.deepEqual(value.analyses[0].filters.range, {
    startSeconds: 0.025,
    endSeconds: 0.075,
  });

  assert.equal(value.calls.filter((call) => call === "encode").length, 1);
});

test("trim analysis receives the explicitly selected source audio index", async () => {
  const value = trimmedPreparation({ streamIndex: 3 });

  value.plan.transformations.unshift({
    type: "extractAudio",
    options: { streamIndex: 3 },
  });

  await prepare(value);

  assert.equal(value.analyses[0].streamIndex, 3);
  assert.equal(value.analyses[0].channels, 2);
});

test("empty audio selection rejects before encoding and releases staging", async () => {
  const value = trimmedPreparation();

  value.dependencies.analyze = async () => ({
    audioSamples: 0,
  });

  await assert.rejects(prepare(value), {
    code: "INVALID_OPTIONS",
    details: {
      reason: "RANGE_TOO_SHORT",
      streamKind: "audio",
    },
  });

  assert.equal(value.calls.includes("encode"), false);
  assert.equal(value.calls.includes("probe-output"), false);
  assert.equal(value.worker.terminations, 1);
  assert.equal(value.files.size, 0);
  assert.equal(value.directories.size, 0);
});

test("invalid audio selection evidence cannot reach encoding", async () => {
  for (const audioSamples of [undefined, -1, 1.5, NaN]) {
    const value = trimmedPreparation();

    value.dependencies.analyze = async () => ({
      audioSamples,
    });

    await assert.rejects(prepare(value), {
      code: "EXECUTION_FAILED",
      details: { reason: "INVALID_TRIM_SELECTION" },
    });

    assert.equal(value.calls.includes("encode"), false);
    assert.equal(value.worker.terminations, 1);
    assert.equal(value.files.size, 0);
  }
});

test("cancellation after trim analysis prevents encoding", async () => {
  const value = trimmedPreparation();

  value.dependencies.analyze = async () => {
    value.controller.abort(new Error("Cancelled after analysis."));
    return { audioSamples: 2400 };
  };

  await assert.rejects(prepare(value), {
    code: "CANCELLED",
  });

  assert.equal(value.calls.includes("encode"), false);
  assert.equal(value.worker.terminations, 1);
  assert.equal(value.files.size, 0);
});

test("trim analysis failure preserves its cause and releases staging", async () => {
  const value = trimmedPreparation();

  const failure = createMavioError("EXECUTION_FAILED", "Analysis failed.", {
    stage: "preparing",
    operation: "trim",
    details: { reason: "TRIM_ANALYSIS_EXIT_FAILURE" },
  });

  value.dependencies.analyze = async () => {
    throw failure;
  };

  await assert.rejects(prepare(value), (error) => {
    assert.equal(error.code, "EXECUTION_FAILED");
    assert.equal(error.cause, failure);
    assert.equal(error.details.reason, "TRIM_ANALYSIS_EXIT_FAILURE");
    return true;
  });

  assert.equal(value.calls.includes("encode"), false);
  assert.equal(value.worker.terminations, 1);
  assert.equal(value.files.size, 0);
});
