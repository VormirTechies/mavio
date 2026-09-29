import assert from "node:assert/strict";
import test from "node:test";
import { createMavioError } from "../../dist/core/errors.js";
import { createPipeline } from "../../dist/core/pipeline.js";

function harness() {
  const calls = [];
  let disposed = false;

  function assertActive() {
    if (disposed) {
      throw createMavioError("DISPOSED", "Client is disposed.");
    }
  }

  const executor = {
    assertActive,

    beforeSubmit(execution) {
      assertActive();

      if (execution?.signal?.aborted) {
        throw createMavioError("CANCELLED", "Request was already cancelled.");
      }
    },

    async execute(plan, execution) {
      calls.push({ type: "execute", plan, execution });

      // Tests submit byte targets only; no media output is claimed.
      return {
        jobId: `recorded-${calls.length}`,
        output: { kind: "bytes", bytes: new Uint8Array([1]) },
        metadata: { streams: [] },
        engine: { id: "recording-executor", version: "test" },
      };
    },

    async probe(input, execution) {
      calls.push({ type: "probe", input, execution });
      return { streams: [], durationSeconds: 5 };
    },
  };

  return {
    calls,
    executor,
    dispose() {
      disposed = true;
    },
  };
}

function source(executor) {
  return createPipeline({ kind: "bytes", bytes: new Uint8Array([1, 2]) }, executor);
}

test("builders stay lazy and branches preserve independent transformations", async () => {
  const { calls, executor } = harness();
  const root = source(executor);
  const parent = root.convert({
    format: "mp4",
    preset: "video-balanced-v1",
  });
  const small = parent.resize({ width: 320, height: 180 });
  const large = parent.resize({ width: 1280, height: 720 });

  assert.equal(calls.length, 0);
  assert.ok(Object.isFrozen(root));
  assert.ok(Object.isFrozen(parent));
  assert.notEqual(small, large);

  await small.export({ output: { kind: "bytes" } });
  await large.export({ output: { kind: "bytes" } });
  await parent.export({ output: { kind: "bytes" } });

  assert.equal(calls[0].plan.transformations[1].options.width, 320);
  assert.equal(calls[1].plan.transformations[1].options.width, 1280);
  assert.equal(calls[2].plan.transformations.length, 1);
  assert.ok(Object.isFrozen(calls[0].plan));
});

test("builder validation throws synchronously without submitting work", () => {
  const { calls, executor } = harness();
  const root = source(executor);

  assert.throws(() => root.trim({ start: 3, end: 1 }), { code: "INVALID_OPTIONS" });
  assert.equal(calls.length, 0);
});

test("terminal validation rejects promises instead of throwing synchronously", async () => {
  const { calls, executor } = harness();
  const root = source(executor);

  const invocations = [
    () => root.export({ output: { kind: "bytes" } }),
    () =>
      root.thumbnail({
        at: -1,
        format: "png",
        preset: "png-lossless-v1",
        output: { kind: "bytes" },
      }),
    () => root.trim({ start: 0, end: 1 }).metadata(),
  ];

  for (const invoke of invocations) {
    let pending;
    assert.doesNotThrow(() => {
      pending = invoke();
    });
    assert.ok(pending instanceof Promise);
    await assert.rejects(pending, { code: "INVALID_OPTIONS" });
  }

  assert.equal(calls.length, 0);
});

test("repeated exports submit separate requests without consuming the pipeline", async () => {
  const { calls, executor } = harness();
  const pipeline = source(executor).convert({
    format: "mp4",
    preset: "video-balanced-v1",
  });

  const results = await Promise.all([
    pipeline.export({ output: { kind: "bytes" } }),
    pipeline.export({ output: { kind: "bytes" } }),
  ]);

  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].plan, calls[1].plan);
  assert.notEqual(results[0].jobId, results[1].jobId);
});

test("metadata and thumbnail route to their corresponding executor methods", async () => {
  const { calls, executor } = harness();
  const root = source(executor);

  const metadata = await root.metadata();
  await root.trim({ start: 0, end: 2 }).thumbnail({
    at: 0.5,
    format: "jpeg",
    preset: "jpeg-balanced-v1",
    output: { kind: "bytes" },
  });

  assert.equal(metadata.durationSeconds, 5);
  assert.equal(calls[0].type, "probe");
  assert.equal(calls[1].type, "execute");
  assert.equal(calls[1].plan.terminal.type, "thumbnail");
  assert.equal(calls[1].plan.transformations[0].type, "trim");
});

test("submission guard precedes terminal validation and existing builders respect disposal", async () => {
  const state = harness();
  const root = source(state.executor);
  const controller = new AbortController();
  controller.abort();

  // Missing encoding would normally be INVALID_OPTIONS.
  await assert.rejects(root.export({ output: { kind: "bytes" } }, { signal: controller.signal }), {
    code: "CANCELLED",
  });

  state.dispose();

  assert.throws(() => root.resize({ width: 320, height: 180 }), { code: "DISPOSED" });
  assert.throws(() => source(state.executor), { code: "DISPOSED" });

  // Disposal wins over both cancellation and malformed terminal options.
  await assert.rejects(root.export({ output: { kind: "bytes" } }, { signal: controller.signal }), {
    code: "DISPOSED",
  });

  assert.equal(state.calls.length, 0);
});
