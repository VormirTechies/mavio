import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { executeNativeAudioFile } from "../../dist/engines/native/audio-execution.js";
import { NativeProcessError } from "../../dist/engines/native/process.js";

const configuration = { cwd: resolve(".") };
const tools = { ffmpeg: { path: resolve("ffmpeg"), version: "test" } };

function options() {
  return {
    inputPath: resolve("input.mp4"),
    outputPath: resolve("intermediate.mp3"),
    inventory: {
      encoders: ["libmp3lame"],
      decoders: [],
      muxers: ["mp3"],
      demuxers: [],
      filters: [],
    },
    plan: {
      input: { kind: "path", path: resolve("input.mp4") },
      transformations: [],
      terminal: {
        type: "export",
        format: "mp3",
        preset: "audio-balanced-v1",
      },
      output: { kind: "bytes" },
    },
    source: {
      metadata: {
        streams: [
          {
            index: 4,
            kind: "audio",
            sampleRate: 48000,
            channels: 2,
          },
        ],
      },
      streams: [{ index: 4, channelLayout: "stereo" }],
    },
  };
}

function context(signal = new AbortController().signal) {
  return { jobId: "audio-execution-test", signal };
}

function missing() {
  throw Object.assign(new Error("Missing"), { code: "ENOENT" });
}

test("occupied intermediate paths reject before FFmpeg starts", async () => {
  for (const isFile of [true, false]) {
    let launches = 0;

    await assert.rejects(
      executeNativeAudioFile(configuration, tools, options(), context(), {
        async inspect() {
          return { isFile: () => isFile, size: 10 };
        },
        async run() {
          launches++;
          return { stdout: "", stderr: "" };
        },
      }),
      { code: "OUTPUT_EXISTS" },
    );

    assert.equal(launches, 0);
  }
});

test("execution launches FFmpeg and checks its new output", async () => {
  const events = [];
  const input = options();
  const ctx = context();

  await executeNativeAudioFile(configuration, tools, input, ctx, {
    async inspect(path) {
      assert.equal(path, input.outputPath);
      events.push("inspect");
      if (events.length === 1) missing();
      return { isFile: () => true, size: 100 };
    },
    async run(call) {
      events.push("run");
      assert.equal(call.executable, tools.ffmpeg.path);
      assert.equal(call.signal, ctx.signal);
      assert.equal(call.args.at(-1), input.outputPath);
      assert.ok(call.args.includes("-n"));
      return { stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(events, ["inspect", "run", "inspect"]);
});

test("inspection errors are not mistaken for an absent output", async () => {
  const cause = Object.assign(new Error("Denied"), { code: "EACCES" });
  let launches = 0;

  await assert.rejects(
    executeNativeAudioFile(configuration, tools, options(), context(), {
      async inspect() {
        throw cause;
      },
      async run() {
        launches++;
        return { stdout: "", stderr: "" };
      },
    }),
    (error) => {
      assert.equal(error.code, "IO_ERROR");
      assert.equal(error.cause, cause);
      return true;
    },
  );

  assert.equal(launches, 0);
});

test("zero exit status with an error diagnostic is not encoding success", async () => {
  await assert.rejects(
    executeNativeAudioFile(configuration, tools, options(), context(), {
      async inspect() {
        missing();
      },
      async run() {
        return {
          stdout: "",
          stderr: "File already exists. Exiting.\n",
        };
      },
    }),
    (error) => {
      assert.equal(error.code, "EXECUTION_FAILED");
      assert.equal(error.details.reason, "ENCODER_ERROR_DIAGNOSTIC");
      return true;
    },
  );
});

test("empty or non-regular encoded outputs reject", async () => {
  for (const file of [
    { isFile: () => true, size: 0 },
    { isFile: () => false, size: 100 },
  ]) {
    let inspections = 0;

    await assert.rejects(
      executeNativeAudioFile(configuration, tools, options(), context(), {
        async inspect() {
          if (++inspections === 1) missing();
          return file;
        },
        async run() {
          return { stdout: "", stderr: "" };
        },
      }),
      (error) => {
        assert.equal(error.code, "EXECUTION_FAILED");
        assert.equal(error.details.reason, "INVALID_ENCODED_OUTPUT");
        return true;
      },
    );
  }
});

test("cancellation prevents launch and process failures retain their cause", async () => {
  const controller = new AbortController();
  let launches = 0;

  await assert.rejects(
    executeNativeAudioFile(configuration, tools, options(), context(controller.signal), {
      async inspect() {
        controller.abort();
        missing();
      },
      async run() {
        launches++;
        return { stdout: "", stderr: "" };
      },
    }),
    { code: "CANCELLED" },
  );

  assert.equal(launches, 0);

  const cause = new NativeProcessError("NONZERO_EXIT", { exitCode: 1 });

  await assert.rejects(
    executeNativeAudioFile(configuration, tools, options(), context(), {
      async inspect() {
        missing();
      },
      async run() {
        throw cause;
      },
    }),
    (error) => {
      assert.equal(error.code, "EXECUTION_FAILED");
      assert.equal(error.cause, cause);
      assert.equal(error.jobId, "audio-execution-test");
      return true;
    },
  );
});

test("audio cancellation after encoding prevents accepting the output", async () => {
  const controller = new AbortController();
  const reason = new Error("Cancelled after encoding");
  let inspections = 0;

  await assert.rejects(
    executeNativeAudioFile(configuration, tools, options(), context(controller.signal), {
      async inspect() {
        inspections++;
        missing();
      },
      async run() {
        controller.abort(reason);
        return { stdout: "", stderr: "" };
      },
    }),
    (error) => {
      assert.equal(error.code, "CANCELLED");
      assert.equal(error.cause, reason);
      assert.equal(error.jobId, "audio-execution-test");
      return true;
    },
  );

  assert.equal(inspections, 1);
});

test("WAV execution uses PCM and validates the resulting file", async () => {
  const input = options();
  input.outputPath = resolve("intermediate.wav");
  input.plan.terminal = {
    type: "export",
    format: "wav",
    preset: "audio-pcm-v1",
  };
  input.inventory.encoders = ["pcm_s16le"];
  input.inventory.muxers = ["wav"];

  const events = [];

  await executeNativeAudioFile(configuration, tools, input, context(), {
    async inspect(path) {
      assert.equal(path, input.outputPath);
      events.push("inspect");

      if (events.length === 1) missing();

      return { isFile: () => true, size: 4096 };
    },
    async run(call) {
      events.push("run");

      assert.equal(call.args[call.args.indexOf("-c:a") + 1], "pcm_s16le");
      assert.equal(call.args[call.args.indexOf("-f") + 1], "wav");
      assert.equal(call.args[call.args.indexOf("-map") + 1], "0:4");
      assert.equal(call.args.includes("-b:a"), false);
      assert.equal(call.args.at(-1), input.outputPath);
      assert.equal(call.cwd, configuration.cwd);

      return { stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(events, ["inspect", "run", "inspect"]);
});
