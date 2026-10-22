import assert from "node:assert/strict";
import test from "node:test";
import { executeBrowserMp4File } from "../../dist/engines/browser/mp4-execution.js";

function commandOptions() {
  return {
    plan: {
      input: { kind: "bytes", bytes: new Uint8Array([1]) },
      transformations: [],
      terminal: {
        type: "export",
        format: "mp4",
        preset: "video-balanced-v1",
      },
      output: { kind: "bytes" },
    },
    source: {
      metadata: {
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
    },
    inventory: {
      encoders: ["libx264"],
      decoders: ["h264"],
      muxers: ["mp4"],
      demuxers: ["mov", "mp4"],
      filters: [],
    },
    inputPath: "/mavio-execution/input.bin",
    outputPath: "/mavio-execution/output.mp4",
  };
}

function context(controller = new AbortController()) {
  return {
    jobId: "browser-mp4-execution-test",
    signal: controller.signal,
    reportProgress() {},
  };
}

function fixture(options = {}) {
  const entries = [{ name: "input.bin", isDir: false }];
  const listeners = new Set();
  const calls = [];
  let started;

  const entered = new Promise((resolve) => {
    started = resolve;
  });

  if (options.occupied) {
    entries.push({
      name: "output.mp4",
      isDir: options.occupied === "directory",
    });
  }

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
      if (options.inspectFailure) throw options.inspectFailure;
      return entries.map((entry) => ({ ...entry }));
    },

    async exec(args) {
      calls.push(["exec", args]);
      started();

      if (options.stall) return new Promise(() => {});
      if (options.execFailure) throw options.execFailure;

      const messages = options.logs ?? (options.diagnostic ? ["Simulated encoder error."] : []);

      for (const message of messages) {
        for (const listener of listeners) {
          listener({ type: "stderr", message });
        }
      }

      if (!options.missingOutput) {
        entries.push({
          name: "output.mp4",
          isDir: options.outputDirectory ?? false,
        });
      }

      return options.exitCode ?? 0;
    },

    terminate() {
      this.loaded = false;
      this.terminations += 1;
    },
  };

  return { worker, listeners, calls, entered };
}

test("browser MP4 execution checks destination and creates the expected file", async () => {
  const { worker, listeners, calls } = fixture();

  await executeBrowserMp4File(worker, commandOptions(), context());

  assert.deepEqual(
    calls.map(([operation]) => operation),
    ["list", "exec", "list"],
  );
  assert.equal(listeners.size, 0);
  assert.equal(worker.terminations, 0);
});

test("existing browser output files and directories reject before encoding", async () => {
  for (const occupied of ["file", "directory"]) {
    const { worker, calls } = fixture({ occupied });

    await assert.rejects(executeBrowserMp4File(worker, commandOptions(), context()), {
      code: "OUTPUT_EXISTS",
      details: { reason: "INTERMEDIATE_OUTPUT_EXISTS" },
    });

    assert.equal(
      calls.some(([operation]) => operation === "exec"),
      false,
    );
  }
});

test("output inspection errors preserve their cause and prevent encoding", async () => {
  const failure = new Error("Directory inspection failed.");
  const { worker, calls } = fixture({ inspectFailure: failure });

  await assert.rejects(executeBrowserMp4File(worker, commandOptions(), context()), (error) => {
    assert.equal(error.code, "IO_ERROR");
    assert.equal(error.cause, failure);
    return true;
  });

  assert.equal(
    calls.some(([operation]) => operation === "exec"),
    false,
  );
});

test("browser encoding rejects nonzero exits including -1", async () => {
  for (const exitCode of [1, -1]) {
    const { worker, listeners } = fixture({ exitCode });

    await assert.rejects(executeBrowserMp4File(worker, commandOptions(), context()), {
      code: "EXECUTION_FAILED",
      details: { reason: "ENCODER_EXIT_FAILURE" },
    });

    assert.equal(listeners.size, 0);
  }
});

test("zero exit with an error diagnostic is rejected", async () => {
  const { worker, listeners } = fixture({ diagnostic: true });

  await assert.rejects(executeBrowserMp4File(worker, commandOptions(), context()), {
    code: "EXECUTION_FAILED",
    details: { reason: "ENCODER_ERROR_DIAGNOSTIC" },
  });

  assert.equal(listeners.size, 0);
});

test("missing output and directory output are rejected", async () => {
  for (const options of [{ missingOutput: true }, { outputDirectory: true }]) {
    const { worker } = fixture(options);

    await assert.rejects(executeBrowserMp4File(worker, commandOptions(), context()), {
      code: "EXECUTION_FAILED",
      details: { reason: "INVALID_ENCODED_OUTPUT" },
    });
  }
});

test("cancellation interrupts stalled browser encoding and removes its listener", async () => {
  const controller = new AbortController();
  const { worker, listeners, entered } = fixture({ stall: true });

  const pending = executeBrowserMp4File(worker, commandOptions(), context(controller));

  const rejected = assert.rejects(pending, {
    code: "CANCELLED",
    stage: "running",
  });

  await entered;
  controller.abort();
  await rejected;

  assert.equal(worker.terminations, 1);
  assert.equal(listeners.size, 0);
});

test("worker execution failures preserve their original cause", async () => {
  const failure = new Error("Worker execution failed.");
  const { worker, listeners } = fixture({ execFailure: failure });

  await assert.rejects(executeBrowserMp4File(worker, commandOptions(), context()), (error) => {
    assert.equal(error.code, "EXECUTION_FAILED");
    assert.equal(error.cause, failure);
    return true;
  });

  assert.equal(listeners.size, 0);
});

test("invalid plans reject before worker filesystem access", async () => {
  const { worker, calls } = fixture();
  const options = commandOptions();
  options.outputPath = options.inputPath;

  await assert.rejects(executeBrowserMp4File(worker, options, context()), {
    code: "INVALID_OPTIONS",
  });

  assert.deepEqual(calls, []);
});

test("the exact pinned-core marker permits a successful encoding exit", async () => {
  const { worker } = fixture({ logs: ["Aborted()"] });

  await assert.doesNotReject(executeBrowserMp4File(worker, commandOptions(), context()));
});

test("the pinned-core marker never permits a nonzero encoding exit", async () => {
  for (const exitCode of [1, -1]) {
    const { worker } = fixture({
      logs: ["Aborted()"],
      exitCode,
    });

    await assert.rejects(executeBrowserMp4File(worker, commandOptions(), context()), {
      code: "EXECUTION_FAILED",
      details: { reason: "ENCODER_EXIT_FAILURE" },
    });
  }
});

test("other abort messages and diagnostics remain encoding failures", async () => {
  for (const logs of [
    ["Aborted(out of memory)"],
    ["Aborted() unexpected text"],
    ["Aborted()\nEncoder failure"],
    ["Aborted()", "Simulated encoder error."],
  ]) {
    const { worker } = fixture({ logs });

    await assert.rejects(executeBrowserMp4File(worker, commandOptions(), context()), {
      code: "EXECUTION_FAILED",
      details: { reason: "ENCODER_ERROR_DIAGNOSTIC" },
    });
  }
});
