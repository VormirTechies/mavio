import assert from "node:assert/strict";
import test from "node:test";
import { executeBrowserAudioFile } from "../../dist/engines/browser/audio-execution.js";

function context(controller = new AbortController()) {
  return {
    jobId: "browser-audio-execution-test",
    signal: controller.signal,
    reportProgress() {},
  };
}

function fixture(settings = {}) {
  const preset = settings.preset ?? "audio-balanced-v1";

  const format = preset === "audio-balanced-v1" ? "mp3" : "wav";

  const filename = `output.${format}`;
  const listeners = new Set();
  const calls = [];

  const entries = [{ name: "input.bin", isDir: false }];

  let inspectionCount = 0;
  let started;

  const entered = new Promise((resolve) => {
    started = resolve;
  });

  if (settings.occupied) {
    entries.push({
      name: filename,
      isDir: settings.occupied === "directory",
    });
  }

  const options = {
    inputPath: "/mavio-audio-execution/input.bin",
    outputPath: `/mavio-audio-execution/${filename}`,

    plan: {
      input: {
        kind: "bytes",
        bytes: new Uint8Array([1]),
      },
      transformations: [],
      terminal: {
        type: "export",
        format,
        preset,
      },
      output: { kind: "bytes" },
    },

    source: {
      metadata: {
        container: "wav",
        streams: [
          {
            index: 3,
            kind: "audio",
            codec: "pcm_s16le",
            sampleRate: 48000,
            channels: 1,
          },
        ],
      },
      streams: [
        {
          index: 3,
          channelLayout: "mono",
        },
      ],
    },

    inventory: {
      encoders: ["libmp3lame", "pcm_s16le"],
      decoders: ["pcm_s16le"],
      muxers: ["mp3", "wav"],
      demuxers: ["wav"],
      filters: [],
    },
  };

  const worker = {
    loaded: true,
    terminations: 0,

    on(event, callback) {
      assert.equal(event, "log");
      listeners.add(callback);
    },

    off(event, callback) {
      assert.equal(event, "log");
      listeners.delete(callback);
    },

    async listDir(path) {
      calls.push(["list", path]);
      inspectionCount += 1;

      if (inspectionCount === settings.failInspectionAt) {
        throw settings.inspectionFailure;
      }

      return entries.map((entry) => ({ ...entry }));
    },

    async exec(args) {
      calls.push(["exec", args]);
      started();

      if (settings.stall) {
        return new Promise(() => {});
      }

      if (settings.execFailure) {
        throw settings.execFailure;
      }

      for (const message of settings.logs ?? []) {
        for (const listener of listeners) {
          listener({
            type: "stderr",
            message,
          });
        }
      }

      if (!settings.missingOutput) {
        entries.push({
          name: filename,
          isDir: settings.outputDirectory ?? false,
        });
      }

      return settings.exitCode ?? 0;
    },

    terminate() {
      this.loaded = false;
      this.terminations += 1;
    },
  };

  return {
    worker,
    options,
    calls,
    listeners,
    entered,
  };
}

test("browser audio execution supports MP3 and WAV private output files", async () => {
  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    const value = fixture({ preset });

    await executeBrowserAudioFile(value.worker, value.options, context());

    assert.deepEqual(
      value.calls.map(([operation]) => operation),
      ["list", "exec", "list"],
    );

    const command = value.calls.find(([operation]) => operation === "exec")[1];

    assert.equal(command.at(-1), value.options.outputPath);

    assert.equal(value.listeners.size, 0);
    assert.equal(value.worker.terminations, 0);
  }
});

test("existing audio files and directories reject before encoding", async () => {
  for (const occupied of ["file", "directory"]) {
    const value = fixture({ occupied });

    await assert.rejects(executeBrowserAudioFile(value.worker, value.options, context()), {
      code: "OUTPUT_EXISTS",
      details: {
        reason: "INTERMEDIATE_OUTPUT_EXISTS",
      },
    });

    assert.equal(
      value.calls.some(([operation]) => operation === "exec"),
      false,
    );

    assert.equal(value.listeners.size, 0);
  }
});

test("audio output inspection failures preserve their cause and stage", async () => {
  for (const failInspectionAt of [1, 2]) {
    const failure = new Error("Directory inspection failed.");

    const value = fixture({
      failInspectionAt,
      inspectionFailure: failure,
    });

    await assert.rejects(
      executeBrowserAudioFile(value.worker, value.options, context()),
      (error) => {
        assert.equal(error.code, "IO_ERROR");

        assert.equal(error.stage, failInspectionAt === 1 ? "preparing" : "finalizing");

        assert.equal(error.cause, failure);
        return true;
      },
    );

    assert.equal(
      value.calls.some(([operation]) => operation === "exec"),
      failInspectionAt === 2,
    );

    assert.equal(value.listeners.size, 0);
  }
});

test("audio execution rejects nonzero exits and genuine error diagnostics", async () => {
  for (const settings of [
    { exitCode: 1 },
    { exitCode: -1 },
    { exitCode: 1, logs: ["Aborted()"] },
    { logs: ["Encoder failure."] },
    { logs: ["Aborted(out of memory)"] },
    { logs: ["Aborted() unexpected text"] },
  ]) {
    const value = fixture(settings);

    await assert.rejects(
      executeBrowserAudioFile(value.worker, value.options, context()),
      (error) => {
        assert.equal(error.code, "EXECUTION_FAILED");

        assert.equal(
          error.details.reason,
          settings.exitCode ? "ENCODER_EXIT_FAILURE" : "ENCODER_ERROR_DIAGNOSTIC",
        );

        return true;
      },
    );

    assert.equal(value.listeners.size, 0);
  }
});

test("only the exact pinned-core marker permits a zero-exit audio execution", async () => {
  const value = fixture({
    logs: ["Aborted()"],
  });

  await executeBrowserAudioFile(value.worker, value.options, context());

  assert.equal(value.listeners.size, 0);
});

test("missing audio output and directory output reject during finalization", async () => {
  for (const settings of [{ missingOutput: true }, { outputDirectory: true }]) {
    const value = fixture(settings);

    await assert.rejects(executeBrowserAudioFile(value.worker, value.options, context()), {
      code: "EXECUTION_FAILED",
      stage: "finalizing",
      details: {
        reason: "INVALID_ENCODED_OUTPUT",
      },
    });

    assert.equal(value.listeners.size, 0);
  }
});

test("audio worker failures preserve the original cause", async () => {
  const failure = new Error("Worker execution failed.");

  const value = fixture({
    execFailure: failure,
  });

  await assert.rejects(executeBrowserAudioFile(value.worker, value.options, context()), (error) => {
    assert.equal(error.code, "EXECUTION_FAILED");
    assert.equal(error.stage, "running");
    assert.equal(error.cause, failure);
    return true;
  });

  assert.equal(value.listeners.size, 0);
});

test("pre-aborted and invalid audio requests avoid filesystem access", async () => {
  const cancelled = fixture();
  const controller = new AbortController();

  controller.abort();

  await assert.rejects(
    executeBrowserAudioFile(cancelled.worker, cancelled.options, context(controller)),
    {
      code: "CANCELLED",
      stage: "preparing",
    },
  );

  assert.deepEqual(cancelled.calls, []);
  assert.equal(cancelled.worker.terminations, 0);

  const invalid = fixture();

  invalid.options.outputPath = invalid.options.inputPath;

  await assert.rejects(executeBrowserAudioFile(invalid.worker, invalid.options, context()), {
    code: "INVALID_OPTIONS",
  });

  assert.deepEqual(invalid.calls, []);
});

test("cancellation interrupts stalled audio encoding and removes listeners", async () => {
  const controller = new AbortController();
  const value = fixture({ stall: true });

  const pending = executeBrowserAudioFile(value.worker, value.options, context(controller));

  const rejected = assert.rejects(pending, {
    code: "CANCELLED",
    stage: "running",
  });

  await value.entered;
  controller.abort();
  await rejected;

  assert.equal(value.worker.terminations, 1);
  assert.equal(value.listeners.size, 0);
});
