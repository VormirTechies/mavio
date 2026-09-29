import assert from "node:assert/strict";
import test from "node:test";
import { EngineSession } from "../../dist/core/engine-session.js";

function context(signal = new AbortController().signal) {
  return {
    jobId: "session-test",
    signal,
    reportProgress() {},
  };
}

function mockEngine(overrides = {}) {
  const calls = [];

  const capabilities = {
    engineId: "mock",
    engineVersion: "test",
    runtime: "node",
    operations: ["metadata"],
    inputKinds: ["bytes"],
    outputKinds: ["bytes"],
    readableContainers: ["mock"],
    decoders: [],
    encodings: [],
    limits: {},
  };

  const engine = {
    id: "mock",
    runtime: "node",

    async initialize() {
      calls.push("initialize");
    },

    async capabilities() {
      calls.push("capabilities");
      return capabilities;
    },

    async dispose() {
      calls.push("dispose");
    },

    ...overrides,
  };

  return { engine, calls, capabilities };
}

test("session construction and unused disposal never initialize an engine", async () => {
  const { engine, calls } = mockEngine();
  const session = new EngineSession(engine);

  assert.deepEqual(calls, []);
  await session.dispose();
  assert.deepEqual(calls, []);

  await assert.rejects(session.ready(context()), { code: "DISPOSED" });
});

test("successful initialization is reused and capability snapshots are isolated", async () => {
  const { engine, calls, capabilities } = mockEngine();
  const session = new EngineSession(engine);

  const first = await session.ready(context());
  first.operations.push("trim");
  capabilities.operations.push("resize");

  const second = await session.ready(context());

  assert.deepEqual(calls, ["initialize", "capabilities"]);
  assert.deepEqual(second.operations, ["metadata"]);

  await session.dispose();
  assert.deepEqual(calls, ["initialize", "capabilities", "dispose"]);
});

test("failed initialization is cleaned up before a later request retries", async () => {
  const calls = [];
  const failure = new Error("First initialization failed.");
  let attempts = 0;

  const { engine } = mockEngine({
    async initialize() {
      calls.push("initialize");
      attempts += 1;
      if (attempts === 1) throw failure;
    },
    async dispose() {
      calls.push("dispose");
    },
  });

  const session = new EngineSession(engine);

  await assert.rejects(session.ready(context()), (error) => {
    assert.equal(error.code, "ENGINE_INIT_FAILED");
    assert.equal(error.cause, failure);
    assert.equal(error.jobId, "session-test");
    assert.equal(error.stage, "preparing");
    return true;
  });

  assert.deepEqual(calls, ["initialize", "dispose"]);

  await session.ready(context());
  assert.deepEqual(calls, ["initialize", "dispose", "initialize"]);

  await session.dispose();
});

test("capability preparation failure also cleans up the engine", async () => {
  const failure = new Error("Capability discovery failed.");
  const { engine, calls } = mockEngine({
    async capabilities() {
      throw failure;
    },
  });

  const session = new EngineSession(engine);

  await assert.rejects(session.ready(context()), (error) => {
    assert.equal(error.code, "ENGINE_INIT_FAILED");
    assert.equal(error.cause, failure);
    return true;
  });

  assert.deepEqual(calls, ["initialize", "dispose"]);

  // Already cleaned up: final disposal should not repeat it.
  await session.dispose();
  assert.deepEqual(calls, ["initialize", "dispose"]);
});

test("failed recovery preserves the primary error and blocks unsafe reuse", async () => {
  const primary = new Error("Initialization failed.");
  let attempts = 0;

  const { engine } = mockEngine({
    async initialize() {
      attempts += 1;
      throw primary;
    },
    async dispose() {
      throw new Error("Cleanup failed.");
    },
  });

  const session = new EngineSession(engine);

  await assert.rejects(session.ready(context()), (error) => {
    assert.equal(error.code, "ENGINE_INIT_FAILED");
    assert.equal(error.cause, primary);
    assert.equal(error.cleanupIssues.length, 1);
    return true;
  });

  await assert.rejects(session.ready(context()), {
    code: "ENGINE_UNAVAILABLE",
  });
  assert.equal(attempts, 1);

  await assert.rejects(session.dispose(), { code: "CLEANUP_FAILED" });
});

test("final disposal failure is shared and never restarts cleanup", async () => {
  let disposals = 0;
  const { engine } = mockEngine({
    async dispose() {
      disposals += 1;
      throw new Error("Disposal failed.");
    },
  });

  const session = new EngineSession(engine);
  await session.ready(context());

  const first = session.dispose();
  assert.equal(session.dispose(), first);
  await assert.rejects(first, { code: "CLEANUP_FAILED" });

  assert.equal(session.dispose(), first);
  assert.equal(disposals, 1);
  await assert.rejects(session.ready(context()), { code: "DISPOSED" });
});

test("pre-aborted initialization makes no engine calls", async () => {
  const { engine, calls } = mockEngine();
  const session = new EngineSession(engine);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(session.ready(context(controller.signal)), {
    code: "CANCELLED",
  });
  assert.deepEqual(calls, []);

  await session.dispose();
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitForAbort(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

test("invalid initialization deadlines fail at session construction", () => {
  const { engine } = mockEngine();

  for (const timeout of [0, -1, 1.5, NaN, Infinity, "100", null]) {
    assert.throws(() => new EngineSession(engine, timeout), { code: "INVALID_OPTIONS" });
  }
});

test("active initialization cancellation waits for cleanup and allows retry", async () => {
  const cleanupStarted = deferred();
  const cleanupFinished = deferred();
  const controller = new AbortController();
  let attempts = 0;

  const { engine } = mockEngine({
    async initialize(ctx) {
      attempts += 1;
      if (attempts === 1) await waitForAbort(ctx.signal);
    },
    async dispose() {
      cleanupStarted.resolve();
      await cleanupFinished.promise;
    },
  });

  const session = new EngineSession(engine);
  const pending = session.ready(context(controller.signal));
  let settled = false;

  const observed = pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const rejection = assert.rejects(pending, { code: "CANCELLED" });

  controller.abort();
  await cleanupStarted.promise;

  assert.equal(settled, false);

  cleanupFinished.resolve();
  await Promise.all([observed, rejection]);

  await session.ready(context());
  assert.equal(attempts, 2);
  await session.dispose();
});

test(
  "startup timeout remains primary if the caller aborts during cleanup",
  {
    timeout: 2000,
  },
  async () => {
    const cleanupStarted = deferred();
    const cleanupFinished = deferred();
    const controller = new AbortController();

    const { engine } = mockEngine({
      async initialize(ctx) {
        await waitForAbort(ctx.signal);
      },
      async dispose() {
        cleanupStarted.resolve();
        await cleanupFinished.promise;
      },
    });

    const session = new EngineSession(engine, 10);
    const pending = session.ready(context(controller.signal));

    const rejection = assert.rejects(pending, (error) => {
      assert.equal(error.code, "ENGINE_INIT_FAILED");
      assert.equal(error.details.reason, "TIMEOUT");
      assert.equal(error.stage, "preparing");
      return true;
    });

    await cleanupStarted.promise;
    controller.abort();
    cleanupFinished.resolve();

    await rejection;
    await session.dispose();
  },
);

test(
  "initialization deadline also covers capability discovery",
  {
    timeout: 2000,
  },
  async () => {
    let initializationSignal;
    let disposed = false;

    const { engine } = mockEngine({
      async initialize(ctx) {
        initializationSignal = ctx.signal;
      },
      async capabilities() {
        await waitForAbort(initializationSignal);
      },
      async dispose() {
        disposed = true;
      },
    });

    const session = new EngineSession(engine, 10);

    await assert.rejects(session.ready(context()), (error) => {
      assert.equal(error.code, "ENGINE_INIT_FAILED");
      assert.equal(error.details.reason, "TIMEOUT");
      return true;
    });

    assert.equal(disposed, true);
    await session.dispose();
  },
);

test("completed initialization detaches its caller abort listener", async () => {
  const controller = new AbortController();
  let initializationSignal;

  const { engine } = mockEngine({
    async initialize(ctx) {
      initializationSignal = ctx.signal;
    },
  });

  const session = new EngineSession(engine);
  await session.ready(context(controller.signal));

  controller.abort();

  assert.equal(initializationSignal.aborted, false);
  await session.ready(context());
  await session.dispose();
});
