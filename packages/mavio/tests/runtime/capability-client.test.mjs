import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityClient } from "../../dist/core/capability-client.js";

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

function mockEngine(overrides = {}) {
  const calls = [];
  const engine = {
    id: "mock",
    runtime: "node",

    async initialize(context) {
      calls.push("initialize");
      await overrides.initialize?.(context);
    },

    async capabilities() {
      calls.push("capabilities");
      return {
        engineId: "mock",
        engineVersion: "test",
        runtime: "node",
        operations: ["metadata"],
        inputKinds: ["bytes"],
        outputKinds: ["bytes"],
        readableContainers: [],
        decoders: [],
        encodings: [],
        limits: {},
      };
    },

    async dispose() {
      calls.push("dispose");
      await overrides.dispose?.();
    },
  };

  return { engine, calls };
}

test("concurrent capability requests initialize once and complete distinct jobs", async () => {
  const gate = deferred();
  const { engine, calls } = mockEngine({
    initialize: () => gate.promise,
  });
  const client = createCapabilityClient(engine);
  const firstEvents = [];
  const secondEvents = [];

  assert.deepEqual(calls, []);

  const first = client.capabilities({
    onProgress: (event) => firstEvents.push(event),
  });
  const second = client.capabilities({
    onProgress: (event) => secondEvents.push(event),
  });

  assert.deepEqual(calls, ["initialize"]);
  assert.deepEqual(
    secondEvents.map((event) => event.stage),
    ["queued"],
  );

  gate.resolve();
  const [a, b] = await Promise.all([first, second]);

  assert.deepEqual(calls, ["initialize", "capabilities"]);
  assert.notEqual(firstEvents[0].jobId, secondEvents[0].jobId);

  for (const events of [firstEvents, secondEvents]) {
    assert.deepEqual(
      events.map((event) => event.stage),
      ["queued", "preparing", "running", "finalizing", "completed"],
    );
    assert.equal(events.at(-1).percent, 100);
  }

  a.operations.push("trim");
  assert.deepEqual(b.operations, ["metadata"]);

  await client.dispose();
});

test("overflow and pre-aborted requests emit no progress", async () => {
  const gate = deferred();
  const { engine } = mockEngine({ initialize: () => gate.promise });
  const client = createCapabilityClient(engine, { maxQueuedJobs: 0 });
  const active = client.capabilities();
  const events = [];

  await assert.rejects(client.capabilities({ onProgress: (event) => events.push(event) }), {
    code: "QUEUE_FULL",
  });

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    client.capabilities({
      signal: controller.signal,
      onProgress: (event) => events.push(event),
    }),
    { code: "CANCELLED" },
  );

  assert.deepEqual(events, []);
  gate.resolve();
  await active;
  await client.dispose();
});

test("queued cancellation emits one terminal event with its admitted job ID", async () => {
  const gate = deferred();
  const { engine, calls } = mockEngine({
    initialize: () => gate.promise,
  });
  const client = createCapabilityClient(engine);
  const active = client.capabilities();
  const controller = new AbortController();
  const events = [];

  const waiting = client.capabilities({
    signal: controller.signal,
    onProgress: (event) => events.push(event),
  });

  const rejected = assert.rejects(waiting, (error) => {
    assert.equal(error.code, "CANCELLED");
    assert.equal(error.jobId, events[0].jobId);
    assert.equal(error.stage, "queued");
    return true;
  });

  controller.abort();
  await rejected;

  assert.deepEqual(
    events.map((event) => event.stage),
    ["queued", "cancelled"],
  );
  assert.deepEqual(calls, ["initialize"]);

  gate.resolve();
  await active;
  await client.dispose();
});

test("disposal from the queued observer prevents engine initialization", async () => {
  const { engine, calls } = mockEngine();
  const client = createCapabilityClient(engine);
  const events = [];
  let disposal;

  await assert.rejects(
    client.capabilities({
      onProgress(event) {
        events.push(event);
        if (event.stage === "queued") disposal = client.dispose();
      },
    }),
    { code: "CANCELLED" },
  );

  await disposal;
  assert.deepEqual(calls, []);
  assert.deepEqual(
    events.map((event) => event.stage),
    ["queued", "cancelled"],
  );

  await assert.rejects(client.capabilities(), { code: "DISPOSED" });
});

test("active initialization cancellation finishes cleanup before the next job starts", async () => {
  const cleaning = deferred();
  const cleaned = deferred();
  let attempts = 0;
  const { engine, calls } = mockEngine({
    async initialize(context) {
      attempts += 1;
      if (attempts === 1) await waitForAbort(context.signal);
    },
    async dispose() {
      cleaning.resolve();
      await cleaned.promise;
    },
  });

  const client = createCapabilityClient(engine);
  const controller = new AbortController();
  const active = client.capabilities({ signal: controller.signal });
  const rejected = assert.rejects(active, { code: "CANCELLED" });
  const next = client.capabilities();

  controller.abort();
  await cleaning.promise;
  assert.equal(attempts, 1);

  cleaned.resolve();
  await rejected;
  await next;

  assert.deepEqual(calls, ["initialize", "dispose", "initialize", "capabilities"]);

  await client.dispose();
});

test("client disposal shares engine cleanup failure and remains permanent", async () => {
  const { engine, calls } = mockEngine({
    async dispose() {
      throw new Error("Cleanup failed.");
    },
  });
  const client = createCapabilityClient(engine);
  await client.capabilities();

  const disposal = client.dispose();
  assert.equal(client.dispose(), disposal);
  await assert.rejects(disposal, { code: "CLEANUP_FAILED" });
  assert.equal(client.dispose(), disposal);

  await assert.rejects(client.capabilities(), { code: "DISPOSED" });
  assert.equal(calls.filter((call) => call === "dispose").length, 1);
});

test(
  "timeout remains a failed job after caller cancellation during cleanup",
  {
    timeout: 2000,
  },
  async () => {
    const cleaning = deferred();
    const cleaned = deferred();
    const { engine } = mockEngine({
      initialize: (context) => waitForAbort(context.signal),
      async dispose() {
        cleaning.resolve();
        await cleaned.promise;
      },
    });

    const client = createCapabilityClient(engine, { initTimeoutMs: 10 });
    const controller = new AbortController();
    const events = [];

    const rejected = assert.rejects(
      client.capabilities({
        signal: controller.signal,
        onProgress: (event) => events.push(event),
      }),
      (error) => {
        assert.equal(error.code, "ENGINE_INIT_FAILED");
        assert.equal(error.details.reason, "TIMEOUT");
        return true;
      },
    );

    await cleaning.promise;
    controller.abort();
    cleaned.resolve();

    await rejected;
    assert.equal(events.at(-1).stage, "failed");
    await client.dispose();
  },
);
