import assert from "node:assert/strict";
import test from "node:test";
import { runBrowserWorkerCall } from "../../dist/engines/browser/worker-call.js";

function deferred() {
  let resolve;
  let reject;

  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });

  return { promise, resolve, reject };
}

function context(controller = new AbortController()) {
  return {
    jobId: "browser-worker-call-test",
    signal: controller.signal,
    reportProgress() {},
  };
}

function worker() {
  return {
    loaded: true,
    terminations: 0,

    terminate() {
      this.terminations += 1;
      this.loaded = false;
    },
  };
}

test("successful worker calls return their result without termination", async () => {
  const instance = worker();
  const value = new Uint8Array([1, 2, 3]);

  const result = await runBrowserWorkerCall(instance, context(), async () => value);

  assert.equal(result, value);
  assert.equal(instance.terminations, 0);
  assert.equal(instance.loaded, true);
});

test("pre-aborted calls neither invoke the operation nor terminate the worker", async () => {
  const instance = worker();
  const controller = new AbortController();
  controller.abort();

  let calls = 0;

  await assert.rejects(
    runBrowserWorkerCall(instance, context(controller), async () => {
      calls += 1;
    }),
    { code: "CANCELLED" },
  );

  assert.equal(calls, 0);
  assert.equal(instance.terminations, 0);
});

test("cancellation terminates a worker whose operation never settles", async () => {
  const instance = worker();
  const controller = new AbortController();
  const entered = deferred();

  const pending = runBrowserWorkerCall(instance, context(controller), () => {
    entered.resolve();
    return new Promise(() => {});
  });

  const rejected = assert.rejects(pending, {
    code: "CANCELLED",
    jobId: "browser-worker-call-test",
  });

  await entered.promise;
  controller.abort();
  await rejected;

  assert.equal(instance.terminations, 1);
  assert.equal(instance.loaded, false);
});

test("cancellation before deferred invocation prevents the worker call", async () => {
  const instance = worker();
  const controller = new AbortController();
  let calls = 0;

  const pending = runBrowserWorkerCall(instance, context(controller), async () => {
    calls += 1;
  });

  const rejected = assert.rejects(pending, { code: "CANCELLED" });

  controller.abort();
  await rejected;

  assert.equal(calls, 0);
  assert.equal(instance.terminations, 1);
});

test("worker call failures preserve the original error", async () => {
  const instance = worker();
  const failure = new Error("Simulated filesystem failure.");

  await assert.rejects(
    runBrowserWorkerCall(instance, context(), () => {
      throw failure;
    }),
    (error) => error === failure,
  );

  assert.equal(instance.terminations, 0);
});

test("late operation rejection after cancellation is observed", async () => {
  const instance = worker();
  const controller = new AbortController();
  const entered = deferred();
  const operation = deferred();

  const pending = runBrowserWorkerCall(instance, context(controller), () => {
    entered.resolve();
    return operation.promise;
  });

  const rejected = assert.rejects(pending, { code: "CANCELLED" });

  await entered.promise;
  controller.abort();
  await rejected;

  operation.reject(new Error("Late wrapper rejection."));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(instance.terminations, 1);
});

test("completed calls remove abort listeners on success and failure", async () => {
  for (const fail of [false, true]) {
    const instance = worker();
    const controller = new AbortController();

    const pending = runBrowserWorkerCall(instance, context(controller), async () => {
      if (fail) throw new Error("Expected failure.");
      return 42;
    });

    if (fail) {
      await assert.rejects(pending, /Expected failure/);
    } else {
      assert.equal(await pending, 42);
    }

    controller.abort();

    assert.equal(instance.terminations, 0);
  }
});

test("termination failures remain cancellation errors with cleanup diagnostics", async () => {
  const instance = worker();
  const controller = new AbortController();
  const entered = deferred();

  instance.terminate = () => {
    throw new Error("Simulated termination failure.");
  };

  const pending = runBrowserWorkerCall(instance, context(controller), () => {
    entered.resolve();
    return new Promise(() => {});
  });

  const rejected = assert.rejects(pending, (error) => {
    assert.equal(error.code, "CANCELLED");
    assert.deepEqual(error.cleanupIssues, ["Browser worker termination failed."]);
    assert.ok(error.cause instanceof AggregateError);
    return true;
  });

  await entered.promise;
  controller.abort();
  await rejected;
});

test("an unloaded worker rejects before invoking the operation", async () => {
  const instance = worker();
  instance.loaded = false;

  let calls = 0;

  await assert.rejects(
    runBrowserWorkerCall(instance, context(), async () => {
      calls += 1;
    }),
    { code: "ENGINE_UNAVAILABLE" },
  );

  assert.equal(calls, 0);
});
