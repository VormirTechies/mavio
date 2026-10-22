import assert from "node:assert/strict";
import test from "node:test";
import { executeBrowserThumbnailFile } from "../../dist/engines/browser/thumbnail-execution.js";

function context(controller = new AbortController()) {
  return {
    jobId: "browser-thumbnail-execution-test",
    signal: controller.signal,
    reportProgress() {},
  };
}

function fixture(settings = {}) {
  const preset = settings.preset ?? "jpeg-balanced-v1";

  const format = preset === "jpeg-balanced-v1" ? "jpeg" : "png";

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
    inputPath: "/mavio-thumbnail-execution/input.bin",
    outputPath: `/mavio-thumbnail-execution/${filename}`,

    plan: {
      input: {
        kind: "bytes",
        bytes: new Uint8Array([1]),
      },
      transformations: [],
      terminal: {
        type: "thumbnail",
        at: 0.125,
        format,
        preset,
      },
      output: { kind: "bytes" },
    },

    source: {
      metadata: {
        container: "mov,mp4,m4a,3gp,3g2,mj2",
        durationSeconds: 1,
        streams: [
          {
            index: 3,
            kind: "video",
            codec: "h264",
            width: 320,
            height: 180,
          },
        ],
      },
      formatStartTimeSeconds: 0,
      streams: [
        {
          index: 3,
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
    },

    inventory: {
      encoders: ["mjpeg", "png"],
      decoders: ["h264"],
      muxers: ["image2pipe"],
      demuxers: ["mov"],
      filters: ["trim", "setpts", "scale", "format", "setsar"],
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
  for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
    const value = fixture({ preset });

    await executeBrowserThumbnailFile(value.worker, value.options, context());

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

    await assert.rejects(executeBrowserThumbnailFile(value.worker, value.options, context()), {
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
      executeBrowserThumbnailFile(value.worker, value.options, context()),
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
      executeBrowserThumbnailFile(value.worker, value.options, context()),
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

  await executeBrowserThumbnailFile(value.worker, value.options, context());

  assert.equal(value.listeners.size, 0);
});

test("missing audio output and directory output reject during finalization", async () => {
  for (const settings of [{ missingOutput: true }, { outputDirectory: true }]) {
    const value = fixture(settings);

    await assert.rejects(executeBrowserThumbnailFile(value.worker, value.options, context()), {
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

  await assert.rejects(
    executeBrowserThumbnailFile(value.worker, value.options, context()),
    (error) => {
      assert.equal(error.code, "EXECUTION_FAILED");
      assert.equal(error.stage, "running");
      assert.equal(error.cause, failure);
      return true;
    },
  );

  assert.equal(value.listeners.size, 0);
});

test("pre-aborted and invalid audio requests avoid filesystem access", async () => {
  const cancelled = fixture();
  const controller = new AbortController();

  controller.abort();

  await assert.rejects(
    executeBrowserThumbnailFile(cancelled.worker, cancelled.options, context(controller)),
    {
      code: "CANCELLED",
      stage: "preparing",
    },
  );

  assert.deepEqual(cancelled.calls, []);
  assert.equal(cancelled.worker.terminations, 0);

  const invalid = fixture();

  invalid.options.outputPath = invalid.options.inputPath;

  await assert.rejects(executeBrowserThumbnailFile(invalid.worker, invalid.options, context()), {
    code: "INVALID_OPTIONS",
  });

  assert.deepEqual(invalid.calls, []);
});

test("cancellation interrupts stalled audio encoding and removes listeners", async () => {
  const controller = new AbortController();
  const value = fixture({ stall: true });

  const pending = executeBrowserThumbnailFile(value.worker, value.options, context(controller));

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
