import assert from "node:assert/strict";
import test from "node:test";
import { createMavioError } from "../../dist/core/errors.js";
import { captureNativeConfiguration } from "../../dist/engines/native/config.js";
import { discoverNativeTools } from "../../dist/engines/native/discovery.js";
import { NativeProcessError } from "../../dist/engines/native/process.js";
import { prepareNativeTools } from "../../dist/engines/native/prepare.js";

function configuration() {
  return captureNativeConfiguration(
    {},
    {
      cwd: "/project",
      path: "/first:/second",
      platform: "posix",
    },
  );
}

function context(signal = new AbortController().signal) {
  return { jobId: "prepare-test", signal };
}

async function selectedTools() {
  return {
    ffmpegPath: "/first/ffmpeg",
    ffprobePath: "/first/ffprobe",
  };
}

test("preparation records independent versions and uses bounded version commands", async () => {
  const calls = [];
  const ctx = context();

  const result = await prepareNativeTools(configuration(), ctx, {
    discover: selectedTools,
    async run(options) {
      calls.push(options);

      return {
        stdout: options.executable.endsWith("/ffmpeg")
          ? "ffmpeg version 6.1.1 Copyright (c) FFmpeg developers\nconfiguration: private\n"
          : "ffprobe version 4.0.2 Copyright (c) FFmpeg developers\n",
        stderr: "",
      };
    },
  });

  assert.deepEqual(result, {
    ffmpeg: { path: "/first/ffmpeg", version: "6.1.1" },
    ffprobe: { path: "/first/ffprobe", version: "4.0.2" },
  });

  assert.deepEqual(
    calls.map((call) => call.executable),
    ["/first/ffmpeg", "/first/ffprobe"],
  );

  for (const call of calls) {
    assert.deepEqual(call.args, ["-version"]);
    assert.equal(call.cwd, "/project");
    assert.equal(call.signal, ctx.signal);
    assert.equal(call.maxOutputBytes, 65_536);
  }

  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.ffmpeg));
  assert.ok(Object.isFrozen(result.ffprobe));
});

test("wrong identities and malformed version banners are rejected", async () => {
  const cases = [
    ["ffmpeg", ""],
    ["ffmpeg", "ffprobe version 7.0"],
    ["ffmpeg", "unexpected prefix ffmpeg version 7.0"],
    ["ffmpeg", "ffmpeg version"],
    ["ffmpeg", `ffmpeg version ${"x".repeat(201)}`],
    ["ffprobe", "ffmpeg version 7.0"],
  ];

  for (const [badTool, banner] of cases) {
    await assert.rejects(
      prepareNativeTools(configuration(), context(), {
        discover: selectedTools,
        async run({ executable }) {
          const tool = executable.endsWith("/ffmpeg") ? "ffmpeg" : "ffprobe";

          return {
            stdout: tool === badTool ? banner : `${tool} version 7.0`,
            stderr: "",
          };
        },
      }),
      {
        code: "ENGINE_INIT_FAILED",
        stage: "preparing",
        jobId: "prepare-test",
        details: {
          reason: "INVALID_VERSION_BANNER",
          tool: badTool,
        },
      },
    );
  }
});

test("a selected executable failure never falls back to a later candidate", async () => {
  const launches = [];
  const inspected = [];

  await assert.rejects(
    prepareNativeTools(configuration(), context(), {
      discover: (config, ctx) =>
        discoverNativeTools(config, ctx, async (path) => {
          inspected.push(path);
          return { isFile: () => true };
        }),
      async run({ executable }) {
        launches.push(executable);
        throw new NativeProcessError("SPAWN_FAILED");
      },
    }),
    {
      code: "ENGINE_INIT_FAILED",
      details: { reason: "SPAWN_FAILED", tool: "ffmpeg" },
    },
  );

  assert.deepEqual(inspected, ["/first/ffmpeg", "/first/ffprobe"]);
  assert.deepEqual(launches, ["/first/ffmpeg"]);
});

test("discovery failure prevents all version commands", async () => {
  let launches = 0;

  await assert.rejects(
    prepareNativeTools(configuration(), context(), {
      async discover() {
        throw createMavioError("ENGINE_UNAVAILABLE", "Missing ffprobe.", {
          stage: "preparing",
          details: { reason: "BINARY_NOT_FOUND", tool: "ffprobe" },
        });
      },
      async run() {
        launches += 1;
        return { stdout: "", stderr: "" };
      },
    }),
    {
      code: "ENGINE_UNAVAILABLE",
      details: { reason: "BINARY_NOT_FOUND", tool: "ffprobe" },
    },
  );

  assert.equal(launches, 0);
});

test("pre-aborted preparation does not discover or launch tools", async () => {
  const controller = new AbortController();
  controller.abort();
  let discoveries = 0;

  await assert.rejects(
    prepareNativeTools(configuration(), context(controller.signal), {
      async discover() {
        discoveries += 1;
        return selectedTools();
      },
    }),
    { code: "CANCELLED", stage: "preparing" },
  );

  assert.equal(discoveries, 0);
});

test("cancellation during a version command prevents checking the next tool", async () => {
  const controller = new AbortController();
  const launches = [];

  await assert.rejects(
    prepareNativeTools(configuration(), context(controller.signal), {
      discover: selectedTools,
      async run({ executable, signal }) {
        launches.push(executable);
        controller.abort();

        throw new NativeProcessError("CANCELLED", {
          cause: signal.reason,
        });
      },
    }),
    {
      code: "CANCELLED",
      details: { reason: "CANCELLED", tool: "ffmpeg" },
    },
  );

  assert.deepEqual(launches, ["/first/ffmpeg"]);
});
