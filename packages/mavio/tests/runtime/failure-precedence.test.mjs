import assert from "node:assert/strict";
import test from "node:test";
import { createMavio } from "@vormir/mavio/node";
import { createMavioError } from "../../dist/core/errors.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function observe(promise) {
  return promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
}

function fixture(phase, { cleanupFails = false, holdExecution = false } = {}) {
  const controller = new AbortController();
  const cleaning = deferred();
  const cleaned = deferred();
  const executing = deferred();
  const allowFailure = deferred();
  const events = [];
  const counts = { initialize: 0, dispose: 0 };

  const expectedCode = {
    initialize: "ENGINE_UNAVAILABLE",
    probe: "INVALID_MEDIA",
    execute: "IO_ERROR",
  }[phase];

  const primary = createMavioError(expectedCode, `Failure during ${phase}.`);
  let failed = false;

  function failAt(current) {
    if (phase === current && !failed) {
      failed = true;
      throw primary;
    }
  }

  const engine = {
    id: "failure-precedence",
    runtime: "node",

    async initialize() {
      counts.initialize += 1;
      failAt("initialize");
    },

    async capabilities() {
      return {
        engineId: engine.id,
        engineVersion: "test",
        runtime: "node",
        operations: ["metadata", "convert"],
        inputKinds: ["bytes"],
        outputKinds: ["bytes"],
        readableContainers: [],
        decoders: [],
        encodings: [{ container: "mp4", preset: "video-balanced-v1" }],
        limits: {},
      };
    },

    async probe() {
      failAt("probe");
      return {
        durationSeconds: 1,
        streams: [{ index: 0, kind: "video" }],
      };
    },

    async supports() {
      return { status: "supported" };
    },

    async execute() {
      executing.resolve();

      if (holdExecution) {
        await allowFailure.promise;
      }

      failAt("execute");
      throw new Error("Unexpected execution.");
    },

    async dispose() {
      counts.dispose += 1;

      if (counts.dispose === 1) {
        cleaning.resolve();
        await cleaned.promise;

        if (cleanupFails) {
          throw new Error("Cleanup also failed.");
        }
      }
    },
  };

  const client = createMavio({ engine });

  function run() {
    const options = {
      signal: controller.signal,
      onProgress: (event) => events.push(event),
    };

    if (phase === "initialize") {
      return client.capabilities(options);
    }

    const pipeline = client.from({
      kind: "bytes",
      bytes: new Uint8Array([1]),
    });

    if (phase === "probe") {
      return pipeline.metadata(options);
    }

    return pipeline
      .convert({ format: "mp4", preset: "video-balanced-v1" })
      .export({ output: { kind: "bytes" } }, options);
  }

  return {
    client,
    controller,
    cleaning,
    cleaned,
    executing,
    allowFailure,
    counts,
    events,
    expectedCode,
    run,
  };
}

for (const phase of ["initialize", "probe", "execute"]) {
  for (const action of ["abort", "dispose"]) {
    test(`${phase} failure survives ${action} during cleanup`, { timeout: 10000 }, async (t) => {
      const f = fixture(phase);

      t.after(async () => {
        f.cleaned.resolve();
        await f.client.dispose();
      });

      let settled = false;
      const outcome = observe(f.run()).then((result) => {
        settled = true;
        return result;
      });

      await f.cleaning.promise;

      // This request must wait until cleanup finishes.
      const next = observe(f.client.capabilities());

      let disposal;
      if (action === "abort") {
        f.controller.abort();
      } else {
        disposal = observe(f.client.dispose());
      }

      await Promise.resolve();

      assert.equal(settled, false);
      assert.equal(f.counts.initialize, 1);

      f.cleaned.resolve();

      const result = await outcome;
      assert.equal(result.error?.code, f.expectedCode);

      assert.deepEqual(
        f.events
          .filter((event) => ["completed", "cancelled", "failed"].includes(event.stage))
          .map((event) => event.stage),
        ["failed"],
      );

      const nextResult = await next;

      if (action === "abort") {
        assert.equal(nextResult.error, undefined);
        assert.equal(f.counts.initialize, 2);
      } else {
        assert.equal(nextResult.error?.code, "CANCELLED");
        assert.equal(f.counts.initialize, 1);
        assert.equal((await disposal).error, undefined);
      }
    });
  }
}

test(
  "late abort and cleanup failure preserve the execution error",
  { timeout: 10000 },
  async (t) => {
    const f = fixture("execute", { cleanupFails: true });

    t.after(async () => {
      f.cleaned.resolve();
      await f.client.dispose();
    });

    const outcome = observe(f.run());

    await f.cleaning.promise;
    f.controller.abort();
    f.cleaned.resolve();

    const result = await outcome;

    assert.equal(result.error?.code, "IO_ERROR");
    assert.equal(result.error.cleanupIssues.length, 1);
    assert.equal(f.events.at(-1).stage, "failed");

    await assert.rejects(f.client.capabilities(), {
      code: "ENGINE_UNAVAILABLE",
    });
  },
);

test(
  "cancellation recorded first remains primary through cleanup failure",
  { timeout: 10000 },
  async (t) => {
    const f = fixture("execute", {
      holdExecution: true,
      cleanupFails: true,
    });

    t.after(async () => {
      f.allowFailure.resolve();
      f.cleaned.resolve();
      await f.client.dispose();
    });

    const outcome = observe(f.run());

    await f.executing.promise;
    f.controller.abort();
    f.allowFailure.resolve();

    await f.cleaning.promise;
    f.cleaned.resolve();

    const result = await outcome;

    assert.equal(result.error?.code, "CANCELLED");
    assert.equal(result.error.cleanupIssues.length, 1);
    assert.equal(f.events.at(-1).stage, "cancelled");
  },
);
