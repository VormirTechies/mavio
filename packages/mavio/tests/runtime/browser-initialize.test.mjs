import assert from "node:assert/strict";
import test from "node:test";
import { initializeBrowserWorker } from "../../dist/engines/browser/initialize.js";
import { initializeEngine } from "../../dist/core/initialization.js";

const configuration = Object.freeze({
  coreURL: "https://mavio.example/core.js",
  wasmURL: "https://mavio.example/core.wasm",
  classWorkerURL: "https://mavio.example/worker.js",
});

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
    signal: controller.signal,
    jobId: "browser-initialize-test",
  };
}

function fakeWorker(loadImplementation) {
  return {
    loaded: false,
    loadCalls: [],
    terminationCount: 0,

    async load(assets) {
      this.loadCalls.push(assets);

      if (loadImplementation) {
        await loadImplementation();
      }

      this.loaded = true;
      return true;
    },

    terminate() {
      this.terminationCount += 1;
      this.loaded = false;
    },
  };
}

test("browser initialization loads captured assets and returns worker ownership", async () => {
  const worker = fakeWorker();
  let loaderCalls = 0;
  const supplied = { ...configuration };

  const pending = initializeBrowserWorker(supplied, context(), async () => {
    loaderCalls += 1;
    return () => worker;
  });

  supplied.coreURL = "https://other.example/changed.js";

  assert.equal(await pending, worker);
  assert.equal(loaderCalls, 1);
  assert.deepEqual(worker.loadCalls, [configuration]);
  assert.equal(worker.terminationCount, 0);

  worker.terminate();
});

test("pre-aborted initialization never loads the wrapper", async () => {
  const controller = new AbortController();
  controller.abort();

  let loaderCalls = 0;

  await assert.rejects(
    initializeBrowserWorker(configuration, context(controller), async () => {
      loaderCalls += 1;
      return () => fakeWorker();
    }),
    { code: "CANCELLED" },
  );

  assert.equal(loaderCalls, 0);
});

test("cancellation during wrapper import prevents late worker creation", async () => {
  const controller = new AbortController();
  const entered = deferred();
  const imported = deferred();
  let creations = 0;

  const pending = initializeBrowserWorker(configuration, context(controller), () => {
    entered.resolve();
    return imported.promise;
  });

  const rejected = assert.rejects(pending, { code: "CANCELLED" });

  await entered.promise;
  controller.abort();
  await rejected;

  imported.resolve(() => {
    creations += 1;
    return fakeWorker();
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(creations, 0);
});

test("cancellation terminates a worker even when load never settles", async () => {
  const controller = new AbortController();
  const entered = deferred();

  const worker = fakeWorker(() => {
    entered.resolve();
    return new Promise(() => {});
  });

  const pending = initializeBrowserWorker(
    configuration,
    context(controller),
    async () => () => worker,
  );

  const rejected = assert.rejects(pending, { code: "CANCELLED" });

  await entered.promise;
  controller.abort();
  await rejected;

  assert.equal(worker.terminationCount, 1);
  assert.equal(worker.loaded, false);
});

test("load failure terminates the failed worker and permits a fresh attempt", async () => {
  const failure = new Error("WASM fetch failed.");
  const failedWorker = fakeWorker(() => {
    throw failure;
  });

  await assert.rejects(
    initializeBrowserWorker(configuration, context(), async () => () => failedWorker),
    (error) => {
      assert.equal(error.code, "ENGINE_INIT_FAILED");
      assert.equal(error.cause, failure);
      return true;
    },
  );

  assert.equal(failedWorker.terminationCount, 1);

  const freshWorker = fakeWorker();

  assert.equal(
    await initializeBrowserWorker(configuration, context(), async () => () => freshWorker),
    freshWorker,
  );

  assert.equal(freshWorker.loadCalls.length, 1);
  freshWorker.terminate();
});

test("wrapper import and constructor failures preserve their causes", async () => {
  const importFailure = new Error("Wrapper import failed.");
  const constructionFailure = new Error("Worker construction failed.");

  for (const [failure, loader] of [
    [
      importFailure,
      async () => {
        throw importFailure;
      },
    ],
    [
      constructionFailure,
      async () => () => {
        throw constructionFailure;
      },
    ],
  ]) {
    await assert.rejects(initializeBrowserWorker(configuration, context(), loader), (error) => {
      assert.equal(error.code, "ENGINE_INIT_FAILED");
      assert.equal(error.cause, failure);
      return true;
    });
  }
});

test("failed termination retains the primary initialization failure", async () => {
  const failure = new Error("Core load failed.");
  const worker = fakeWorker(() => {
    throw failure;
  });

  worker.terminate = () => {
    throw new Error("Termination failed.");
  };

  await assert.rejects(
    initializeBrowserWorker(configuration, context(), async () => () => worker),
    (error) => {
      assert.equal(error.code, "ENGINE_INIT_FAILED");
      assert.equal(error.cause, failure);
      assert.deepEqual(error.cleanupIssues, ["Browser worker termination failed."]);
      return true;
    },
  );
});

test("a load result without ready state is rejected and cleaned up", async () => {
  const worker = fakeWorker();

  worker.load = async () => true;

  await assert.rejects(
    initializeBrowserWorker(configuration, context(), async () => () => worker),
    { code: "ENGINE_INIT_FAILED" },
  );

  assert.equal(worker.terminationCount, 1);
});

test("the existing initialization deadline terminates a stalled browser worker", async () => {
  const worker = fakeWorker(() => new Promise(() => {}));
  let capabilitiesCalls = 0;

  const adapter = {
    id: "browser-initialization-test",

    async initialize(engineContext) {
      await initializeBrowserWorker(configuration, engineContext, async () => () => worker);
    },

    async capabilities() {
      capabilitiesCalls += 1;
      return {};
    },
  };

  await assert.rejects(initializeEngine(adapter, context(), 50), {
    code: "ENGINE_INIT_FAILED",
    details: { reason: "TIMEOUT" },
  });

  assert.equal(worker.terminationCount, 1);
  assert.equal(capabilitiesCalls, 0);
});

test("initialization guidance excludes sensitive cause text", async () => {
  const sensitive = "PRIVATE_MEDIA_PATH_AND_ACCESS_TOKEN";
  const failure = new Error(sensitive);
  const worker = fakeWorker(() => {
    throw failure;
  });

  await assert.rejects(
    initializeBrowserWorker(configuration, context(), async () => () => worker),
    (error) => {
      assert.equal(error.code, "ENGINE_INIT_FAILED");
      assert.equal(error.cause, failure);
      assert.match(error.message, /same-origin/);
      assert.match(error.message, /JS\/WASM/);
      assert.match(error.message, /worker dependencies/);
      assert.match(error.message, /CSP/);
      assert.match(error.message, /deadline/);
      assert.equal(error.message.includes(sensitive), false);
      return true;
    },
  );

  assert.equal(worker.terminationCount, 1);
});
