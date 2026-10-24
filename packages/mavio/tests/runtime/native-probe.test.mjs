import assert from "node:assert/strict";
import test from "node:test";
import { captureNativeConfiguration } from "../../dist/engines/native/config.js";
import { NativeProcessError } from "../../dist/engines/native/process.js";
import { probeNativeFile } from "../../dist/engines/native/probe.js";

const configuration = captureNativeConfiguration(
  {},
  {
    cwd: "/project",
    path: "/tools",
    platform: "posix",
  },
);

const tools = {
  ffmpeg: { path: "/tools/ffmpeg", version: "example" },
  ffprobe: { path: "/tools/ffprobe", version: "example" },
};

function context(signal = new AbortController().signal) {
  return { jobId: "probe-file-test", signal };
}

function output() {
  return {
    stdout: JSON.stringify({
      format: { duration: "2.5" },
      streams: [
        {
          index: 0,
          codec_type: "video",
          width: 320,
          height: 180,
          side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
        },
      ],
    }),
    stderr: "",
  };
}

const regularFile = async () => ({ isFile: () => true });

test("file probing uses the selected FFprobe and passes the path as one argument", async () => {
  const ctx = context();
  const input = "/media/a name & literal; file.mp4";
  const inspected = [];
  const calls = [];

  const result = await probeNativeFile(configuration, tools, input, ctx, {
    async inspect(path) {
      inspected.push(path);
      return { isFile: () => true };
    },
    async run(options) {
      calls.push(options);
      return output();
    },
  });

  assert.deepEqual(inspected, [input]);
  assert.equal(calls.length, 1);

  const call = calls[0];
  assert.equal(call.executable, "/tools/ffprobe");
  assert.equal(call.cwd, "/project");
  assert.equal(call.signal, ctx.signal);
  assert.equal(call.maxOutputBytes, 1_048_576);
  assert.deepEqual(call.args.slice(-2), ["-i", input]);
  assert.equal(call.args[call.args.indexOf("-of") + 1], "json");
  assert.equal(call.args[call.args.indexOf("-protocol_whitelist") + 1], "file");

  const selected = call.args[call.args.indexOf("-show_entries") + 1];
  assert.ok(selected.includes("stream_tags=rotate"));
  assert.ok(selected.includes("stream_side_data=side_data_type,rotation"));

  assert.equal(result.durationSeconds, 2.5);
  assert.equal(result.streams[0].rotationDegrees, 90);
});

test("invalid paths fail before file inspection or process launch", async () => {
  for (const input of ["", "relative.mp4", "-version", "/bad\0name", null]) {
    let calls = 0;

    await assert.rejects(
      probeNativeFile(configuration, tools, input, context(), {
        async inspect() {
          calls += 1;
          return { isFile: () => true };
        },
        async run() {
          calls += 1;
          return output();
        },
      }),
      {
        code: "INVALID_INPUT",
        details: { reason: "INVALID_PROBE_PATH" },
      },
    );

    assert.equal(calls, 0);
  }
});

test("missing files and non-file inputs prevent process launch", async () => {
  const missing = Object.assign(new Error("Missing file"), { code: "ENOENT" });
  let launches = 0;

  const run = async () => {
    launches += 1;
    return output();
  };

  await assert.rejects(
    probeNativeFile(configuration, tools, "/missing.mp4", context(), {
      async inspect() {
        throw missing;
      },
      run,
    }),
    {
      code: "INVALID_INPUT",
      cause: missing,
      details: { reason: "INPUT_STAT_FAILED" },
    },
  );

  await assert.rejects(
    probeNativeFile(configuration, tools, "/directory", context(), {
      inspect: async () => ({ isFile: () => false }),
      run,
    }),
    {
      code: "INVALID_INPUT",
      details: { reason: "INPUT_NOT_FILE" },
    },
  );

  assert.equal(launches, 0);
});

test("pre-aborted probing performs no file inspection", async () => {
  const controller = new AbortController();
  controller.abort();
  let inspections = 0;

  await assert.rejects(
    probeNativeFile(configuration, tools, "/media.mp4", context(controller.signal), {
      async inspect() {
        inspections += 1;
        return { isFile: () => true };
      },
    }),
    { code: "CANCELLED" },
  );

  assert.equal(inspections, 0);
});

test("cancellation during file inspection prevents process launch", async () => {
  const controller = new AbortController();
  let launches = 0;

  await assert.rejects(
    probeNativeFile(configuration, tools, "/media.mp4", context(controller.signal), {
      async inspect() {
        controller.abort();
        return { isFile: () => true };
      },
      async run() {
        launches += 1;
        return output();
      },
    }),
    { code: "CANCELLED" },
  );

  assert.equal(launches, 0);
});

test("probe process failures preserve their cause and classification", async () => {
  for (const reason of [
    "SPAWN_FAILED",
    "NONZERO_EXIT",
    "OUTPUT_LIMIT",
    "STREAM_ERROR",
    "CANCELLED",
  ]) {
    const failure = new NativeProcessError(reason);

    await assert.rejects(
      probeNativeFile(configuration, tools, "/media.mp4", context(), {
        inspect: regularFile,
        async run() {
          throw failure;
        },
      }),
      {
        code: reason === "CANCELLED" ? "CANCELLED" : "EXECUTION_FAILED",
        stage: "preparing",
        jobId: "probe-file-test",
        details: { reason, tool: "ffprobe" },
        cause: failure,
      },
    );
  }
});

test("a runner-selected failure is not replaced by a later abort", async () => {
  const controller = new AbortController();
  const failure = new NativeProcessError("OUTPUT_LIMIT");

  await assert.rejects(
    probeNativeFile(configuration, tools, "/media.mp4", context(controller.signal), {
      inspect: regularFile,
      async run() {
        controller.abort();
        throw failure;
      },
    }),
    {
      code: "EXECUTION_FAILED",
      cause: failure,
      details: { reason: "OUTPUT_LIMIT", tool: "ffprobe" },
    },
  );
});

test("invalid stdout fails even when stderr contains valid metadata", async () => {
  await assert.rejects(
    probeNativeFile(configuration, tools, "/media.mp4", context(), {
      inspect: regularFile,
      async run() {
        return {
          stdout: "private malformed response",
          stderr: output().stdout,
        };
      },
    }),
    {
      code: "EXECUTION_FAILED",
      jobId: "probe-file-test",
      details: {
        reason: "INVALID_PROBE_RESPONSE",
        tool: "ffprobe",
        field: "$",
      },
    },
  );
});

// M7 restricted Native input policy.
test("Native probing restricts demuxers before opening the input", async () => {
  let captured;

  await probeNativeFile(configuration, tools, "/media/source.wav", context(), {
    inspect: regularFile,
    async run(options) {
      captured = options;
      return output();
    },
  });

  const args = captured.args;
  const whitelistIndex = args.indexOf("-format_whitelist");

  assert.ok(whitelistIndex >= 0);
  assert.ok(whitelistIndex < args.indexOf("-i"));
  assert.equal(args[whitelistIndex + 1], "mov,matroska,wav,mp3,flac,jpeg_pipe,png_pipe,image2");
  assert.equal(args.filter((arg) => arg === "-format_whitelist").length, 1);
  assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file");
  assert.equal(args[args.indexOf("-pattern_type") + 1], "none");
  assert.deepEqual(args.slice(-2), ["-i", "/media/source.wav"]);
});

test("Native readable containers exclude reference-bearing and unreviewed demuxers", async () => {
  const { restrictNativeReadableContainers } =
    await import("../../dist/engines/native/input-policy.js");

  const discovered = [
    "concat",
    "wav",
    "mov",
    "mp4",
    "hls",
    "webm",
    "image2",
    "jpeg_pipe",
    "wav",
    "dash",
    "unreviewed",
  ];
  const original = [...discovered];

  const readable = restrictNativeReadableContainers(discovered);

  assert.deepEqual(readable, ["wav", "mov", "mp4", "webm", "image2", "jpeg_pipe"]);
  assert.deepEqual(discovered, original);

  discovered.push("mp3");
  assert.deepEqual(readable, ["wav", "mov", "mp4", "webm", "image2", "jpeg_pipe"]);
  assert.deepEqual(restrictNativeReadableContainers(["concat", "hls"]), []);
});

test("Native input policy retains reviewed formats and immutable command arguments", async () => {
  const { NATIVE_INPUT_ARGUMENTS, NATIVE_INPUT_DEMUXERS } =
    await import("../../dist/engines/native/input-policy.js");

  assert.deepEqual(NATIVE_INPUT_DEMUXERS, [
    "mov",
    "matroska",
    "wav",
    "mp3",
    "flac",
    "jpeg_pipe",
    "png_pipe",
  ]);
  assert.ok(Object.isFrozen(NATIVE_INPUT_DEMUXERS));
  assert.ok(Object.isFrozen(NATIVE_INPUT_ARGUMENTS));
});
