import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runNativeProcess } from "../../dist/engines/native/process.js";

function options(code, extra = {}) {
  return {
    executable: process.execPath,
    args: ["-e", code],
    cwd: process.cwd(),
    signal: new AbortController().signal,
    ...extra,
  };
}

function controlledProcess() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };

  function close(code = null, signal = "SIGKILL") {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, signal);
  }

  return { child, signals, close };
}

test("process runner preserves literal arguments, cwd, and both output streams", async () => {
  const args = ["space value", "& echo unexpected", "$(ignored)", "தமிழ்"];
  const result = await runNativeProcess(
    options(
      `
        process.stdout.write(JSON.stringify({
          args: process.argv.slice(1),
          cwd: process.cwd()
        }));
        process.stderr.write("diagnostic");
      `,
      {
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd()}));process.stderr.write('diagnostic');",
          "--",
          ...args,
        ],
        cwd: tmpdir(),
      },
    ),
  );

  const parsed = JSON.parse(result.stdout);

  assert.deepEqual(parsed.args, args);
  assert.equal(parsed.cwd, tmpdir());
  assert.equal(result.stderr, "diagnostic");
  assert.ok(Object.isFrozen(result));
});

test("nonzero process exits retain the exit code without exposing output", async () => {
  await assert.rejects(
    runNativeProcess(options("process.stderr.write('private diagnostic');process.exitCode=7;")),
    (error) => {
      assert.equal(error.reason, "NONZERO_EXIT");
      assert.equal(error.exitCode, 7);
      assert.equal(error.message.includes("private diagnostic"), false);
      return true;
    },
  );
});

test("missing executables reject as spawn failures", async () => {
  await assert.rejects(
    runNativeProcess(
      options("", {
        executable: join(tmpdir(), `mavio-missing-${randomUUID()}`, "missing-executable"),
      }),
    ),
    { reason: "SPAWN_FAILED" },
  );
});

test("output limits apply to combined stdout and stderr bytes", async () => {
  await assert.rejects(
    runNativeProcess(
      options("process.stdout.write('a'.repeat(40));process.stderr.write('b'.repeat(40));", {
        maxOutputBytes: 64,
      }),
    ),
    { reason: "OUTPUT_LIMIT" },
  );
});

test("pre-aborted requests never launch a process", async () => {
  const controller = new AbortController();
  controller.abort();
  let launches = 0;

  await assert.rejects(
    runNativeProcess(options("", { signal: controller.signal }), () => {
      launches += 1;
      throw new Error("Must not launch.");
    }),
    { reason: "CANCELLED" },
  );

  assert.equal(launches, 0);
});

test("invalid output limits fail before launching", async () => {
  for (const maxOutputBytes of [0, -1, 1.5, Infinity, NaN]) {
    let launches = 0;

    await assert.rejects(
      runNativeProcess(options("", { maxOutputBytes }), () => {
        launches += 1;
        throw new Error("Must not launch.");
      }),
      { code: "INVALID_OPTIONS" },
    );

    assert.equal(launches, 0);
  }
});

test("cancellation terminates the child but waits for close before rejecting", async () => {
  const mock = controlledProcess();
  const controller = new AbortController();

  const pending = runNativeProcess(
    options("", { signal: controller.signal }),
    (_executable, _args, launchOptions) => {
      assert.equal(launchOptions.shell, false);
      assert.equal(launchOptions.windowsHide, true);
      assert.deepEqual(launchOptions.stdio, ["ignore", "pipe", "pipe"]);
      return mock.child;
    },
  );

  let settled = false;
  const observed = pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const rejected = assert.rejects(pending, { reason: "CANCELLED" });

  try {
    controller.abort();
    await Promise.resolve();

    assert.deepEqual(mock.signals, ["SIGKILL"]);
    assert.equal(settled, false);
  } finally {
    mock.close();
  }

  await Promise.all([observed, rejected]);
});

test("an output failure or nonzero exit remains primary after a later abort", async () => {
  for (const reason of ["OUTPUT_LIMIT", "NONZERO_EXIT"]) {
    const mock = controlledProcess();
    const controller = new AbortController();

    const pending = runNativeProcess(
      options("", {
        signal: controller.signal,
        maxOutputBytes: 4,
      }),
      () => mock.child,
    );

    const rejected = assert.rejects(pending, { reason });

    if (reason === "OUTPUT_LIMIT") {
      mock.child.stdout.write(Buffer.from("12345"));
    } else {
      mock.child.emit("exit", 7, null);
    }

    controller.abort();
    mock.close(7, null);

    await rejected;

    assert.deepEqual(mock.signals, reason === "OUTPUT_LIMIT" ? ["SIGKILL"] : []);
  }
});
