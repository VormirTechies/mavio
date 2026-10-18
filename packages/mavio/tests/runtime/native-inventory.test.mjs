import assert from "node:assert/strict";
import test from "node:test";
import { captureNativeConfiguration } from "../../dist/engines/native/config.js";
import { discoverNativeInventory } from "../../dist/engines/native/inventory.js";
import { NativeProcessError } from "../../dist/engines/native/process.js";

const configuration = captureNativeConfiguration(
  {},
  {
    cwd: "/project",
    path: "/tools",
    platform: "posix",
  },
);

const tools = Object.freeze({
  ffmpeg: Object.freeze({ path: "/tools/ffmpeg", version: "example" }),
  ffprobe: Object.freeze({ path: "/tools/ffprobe", version: "example" }),
});

const tables = {
  encoders: "Encoders:\n ------\n V..... libx264 Example\n",
  decoders: "Decoders:\n ------\n V..... h264 Example\n",
  muxers: "File formats:\n --\n  E mp4 Example\n",
  demuxers: "File formats:\n --\n D  mov,mp4 Example\n",
  filters: "Filters:\n ------\n .. trim V->V Example\n",
};

const kinds = Object.keys(tables);

function context(signal = new AbortController().signal) {
  return { jobId: "inventory-test", signal };
}

function kindOf(options) {
  return options.args[1].slice(1);
}

function output(kind) {
  return { stdout: tables[kind], stderr: "" };
}

test("inventory runs five bounded commands against the selected FFmpeg", async () => {
  const calls = [];
  const ctx = context();

  const result = await discoverNativeInventory(configuration, tools, ctx, async (options) => {
    calls.push(options);
    return output(kindOf(options));
  });

  assert.deepEqual(calls.map(kindOf), kinds);

  for (const call of calls) {
    assert.equal(call.executable, "/tools/ffmpeg");
    assert.equal(call.cwd, "/project");
    assert.equal(call.signal, ctx.signal);
    assert.equal(call.maxOutputBytes, 1_048_576);
    assert.deepEqual(call.args, ["-hide_banner", `-${kindOf(call)}`]);
  }

  assert.deepEqual(result, {
    encoders: ["libx264"],
    decoders: ["h264"],
    muxers: ["mp4"],
    demuxers: ["mov", "mp4"],
    filters: ["trim"],
  });

  assert.equal(Object.isFrozen(result), true);

  for (const names of Object.values(result)) {
    assert.equal(Object.isFrozen(names), true);
  }
});

test("stderr diagnostics never become capability data", async () => {
  const result = await discoverNativeInventory(
    configuration,
    tools,
    context(),
    async (options) => ({
      ...output(kindOf(options)),
      stderr: " V..... imaginary_encoder Private diagnostic\n",
    }),
  );

  assert.deepEqual(result.encoders, ["libx264"]);

  await assert.rejects(
    discoverNativeInventory(configuration, tools, context(), async () => ({
      stdout: "",
      stderr: tables.encoders,
    })),
    {
      code: "ENGINE_INIT_FAILED",
      details: {
        reason: "INVALID_CAPABILITY_LIST",
        tool: "ffmpeg",
        list: "encoders",
      },
    },
  );
});

test("a malformed table stops discovery at the failing query", async () => {
  for (const failedKind of kinds) {
    const calls = [];

    await assert.rejects(
      discoverNativeInventory(configuration, tools, context(), async (options) => {
        const kind = kindOf(options);
        calls.push(kind);

        return kind === failedKind
          ? { stdout: "private malformed output", stderr: "" }
          : output(kind);
      }),
      {
        code: "ENGINE_INIT_FAILED",
        stage: "preparing",
        jobId: "inventory-test",
        details: {
          reason: "INVALID_CAPABILITY_LIST",
          tool: "ffmpeg",
          list: failedKind,
        },
      },
    );

    assert.deepEqual(calls, kinds.slice(0, kinds.indexOf(failedKind) + 1));
  }
});

test("runner failures preserve their cause and stop subsequent queries", async () => {
  const failures = [
    new NativeProcessError("SPAWN_FAILED"),
    new NativeProcessError("NONZERO_EXIT", { exitCode: 1 }),
    new NativeProcessError("OUTPUT_LIMIT"),
    new NativeProcessError("STREAM_ERROR"),
    new Error("private unexpected failure"),
  ];

  for (const failure of failures) {
    const calls = [];

    await assert.rejects(
      discoverNativeInventory(configuration, tools, context(), async (options) => {
        const kind = kindOf(options);
        calls.push(kind);

        if (kind === "decoders") throw failure;
        return output(kind);
      }),
      (error) => {
        assert.equal(error.code, "ENGINE_INIT_FAILED");
        assert.equal(error.cause, failure);
        assert.equal(
          error.details.reason,
          failure instanceof NativeProcessError ? failure.reason : "PROCESS_FAILED",
        );
        assert.equal(error.details.list, "decoders");
        assert.equal(error.message.includes("private"), false);
        return true;
      },
    );

    assert.deepEqual(calls, ["encoders", "decoders"]);
  }
});

test("pre-aborted inventory launches no commands", async () => {
  const controller = new AbortController();
  controller.abort("stopped");
  let launches = 0;

  await assert.rejects(
    discoverNativeInventory(configuration, tools, context(controller.signal), async () => {
      launches += 1;
      return output("encoders");
    }),
    {
      code: "CANCELLED",
      stage: "preparing",
      cause: "stopped",
    },
  );

  assert.equal(launches, 0);
});

test("abort after a successful command prevents the next command", async () => {
  const controller = new AbortController();
  const calls = [];

  await assert.rejects(
    discoverNativeInventory(configuration, tools, context(controller.signal), async (options) => {
      const kind = kindOf(options);
      calls.push(kind);
      controller.abort();
      return output(kind);
    }),
    { code: "CANCELLED" },
  );

  assert.deepEqual(calls, ["encoders"]);
});

test("active cancellation waits for the runner to settle", async () => {
  const controller = new AbortController();
  const deferred = Promise.withResolvers();
  let launches = 0;
  let settled = false;

  const pending = discoverNativeInventory(configuration, tools, context(controller.signal), () => {
    launches += 1;
    return deferred.promise;
  });

  const checked = assert.rejects(pending, {
    code: "CANCELLED",
    details: {
      reason: "CANCELLED",
      tool: "ffmpeg",
      list: "encoders",
    },
  });

  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  controller.abort();
  await Promise.resolve();

  assert.equal(settled, false);
  assert.equal(launches, 1);

  deferred.reject(
    new NativeProcessError("CANCELLED", {
      cause: controller.signal.reason,
    }),
  );

  await checked;
  assert.equal(settled, true);
  assert.equal(launches, 1);
});

test("a runner-selected failure survives a later abort", async () => {
  const controller = new AbortController();
  const failure = new NativeProcessError("OUTPUT_LIMIT");

  await assert.rejects(
    discoverNativeInventory(configuration, tools, context(controller.signal), async () => {
      controller.abort();
      throw failure;
    }),
    (error) => {
      assert.equal(error.code, "ENGINE_INIT_FAILED");
      assert.equal(error.details.reason, "OUTPUT_LIMIT");
      assert.equal(error.cause, failure);
      return true;
    },
  );
});
