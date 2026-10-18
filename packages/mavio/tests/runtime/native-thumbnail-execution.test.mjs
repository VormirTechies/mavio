import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { executeNativeThumbnailFile } from "../../dist/engines/native/thumbnail-execution.js";
import { NativeProcessError } from "../../dist/engines/native/process.js";

const configuration = { cwd: resolve(".") };
const tools = { ffmpeg: { path: resolve("ffmpeg"), version: "test" } };

function options() {
  return {
    inputPath: resolve("input.mp4"),
    outputPath: resolve("intermediate.jpg"),
    inventory: {
      encoders: ["mjpeg"],
      decoders: [],
      muxers: ["image2pipe"],
      demuxers: [],
      filters: ["trim", "setpts", "scale", "format"],
    },
    plan: {
      input: { kind: "path", path: resolve("input.mp4") },
      transformations: [],
      terminal: {
        type: "thumbnail",
        at: 0.5,
        format: "jpeg",
        preset: "jpeg-balanced-v1",
      },
      output: { kind: "bytes" },
    },
    source: {
      formatStartTimeSeconds: 0,
      metadata: {
        durationSeconds: 2,
        streams: [{ index: 3, kind: "video", width: 320, height: 180 }],
      },
      streams: [
        {
          index: 3,
          attachedPicture: false,
          pixelFormat: "yuv420p",
          colorTransfer: "bt709",
          colorPrimaries: "bt709",
          colorSpace: "bt709",
          colorRange: "tv",
          defaultOrientation: true,
          sampleAspectRatio: "1:1",
        },
      ],
    },
  };
}

function context(signal = new AbortController().signal) {
  return { jobId: "thumbnail-execution-test", signal };
}

function missing() {
  throw Object.assign(new Error("Missing"), { code: "ENOENT" });
}

test("occupied intermediate paths reject before FFmpeg starts", async () => {
  for (const isFile of [true, false]) {
    let launches = 0;

    await assert.rejects(
      executeNativeThumbnailFile(configuration, tools, options(), context(), {
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

  await executeNativeThumbnailFile(configuration, tools, input, ctx, {
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
    executeNativeThumbnailFile(configuration, tools, options(), context(), {
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
    executeNativeThumbnailFile(configuration, tools, options(), context(), {
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
      executeNativeThumbnailFile(configuration, tools, options(), context(), {
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
    executeNativeThumbnailFile(configuration, tools, options(), context(controller.signal), {
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
    executeNativeThumbnailFile(configuration, tools, options(), context(), {
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
      assert.equal(error.jobId, "thumbnail-execution-test");
      return true;
    },
  );
});

test("thumbnail cancellation after encoding prevents accepting the output", async () => {
  const controller = new AbortController();
  const reason = new Error("Cancelled after encoding");
  let inspections = 0;

  await assert.rejects(
    executeNativeThumbnailFile(configuration, tools, options(), context(controller.signal), {
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
      assert.equal(error.jobId, "thumbnail-execution-test");
      return true;
    },
  );

  assert.equal(inspections, 1);
});

test("PNG execution uses the image encoder and checks its output file", async () => {
  const input = options();
  input.outputPath = resolve("intermediate.png");
  input.plan.terminal = {
    type: "thumbnail",
    at: 0.5,
    format: "png",
    preset: "png-lossless-v1",
  };
  input.inventory.encoders = ["png"];

  const events = [];

  await executeNativeThumbnailFile(configuration, tools, input, context(), {
    async inspect(path) {
      assert.equal(path, input.outputPath);
      events.push("inspect");

      if (events.length === 1) missing();

      return { isFile: () => true, size: 4096 };
    },
    async run(call) {
      events.push("run");

      assert.equal(call.args[call.args.indexOf("-c:v") + 1], "png");
      assert.equal(call.args[call.args.indexOf("-f") + 1], "image2pipe");
      assert.equal(call.args[call.args.indexOf("-map") + 1], "0:3");
      assert.equal(call.args[call.args.indexOf("-frames:v") + 1], "1");
      assert.equal(call.args[call.args.indexOf("-pix_fmt") + 1], "rgb24");
      assert.equal(call.args.includes("-an"), true);
      assert.equal(call.args.at(-1), input.outputPath);
      assert.equal(call.cwd, configuration.cwd);

      return { stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(events, ["inspect", "run", "inspect"]);
});
