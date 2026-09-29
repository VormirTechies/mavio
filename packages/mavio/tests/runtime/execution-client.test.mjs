import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityClient } from "../../dist/core/capability-client.js";
import { createMavioError } from "../../dist/core/errors.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(overrides = {}) {
  const calls = [];
  const bytes = new Uint8Array([7, 8]);
  const source = {
    durationSeconds: 10,
    streams: [{ index: 0, kind: "video", width: 320, height: 180 }],
  };

  const result = () => ({
    output: { kind: "bytes", bytes },
    metadata: structuredClone(source),
    ...(overrides.warnings ? { warnings: overrides.warnings } : {}),
  });

  const engine = {
    id: "execution-mock",
    runtime: "node",

    async initialize() {
      calls.push("initialize");
    },

    async capabilities() {
      calls.push("capabilities");
      return {
        engineId: "execution-mock",
        engineVersion: "test",
        runtime: "node",
        operations: ["metadata", "convert", "trim", "thumbnail"],
        inputKinds: ["bytes"],
        outputKinds: ["bytes"],
        readableContainers: [],
        decoders: [],
        encodings: overrides.encodings ?? [
          { container: "mp4", preset: "video-balanced-v1" },
          { container: "jpeg", preset: "jpeg-balanced-v1" },
        ],
        limits: {},
      };
    },

    async probe() {
      calls.push("probe");
      return structuredClone(source);
    },

    async supports() {
      calls.push("supports");
      return overrides.support ?? { status: "supported" };
    },

    async execute(plan, context) {
      calls.push("execute");

      if (overrides.execute) {
        return overrides.execute(plan, context, result);
      }

      if (!context.beginCommit()) {
        throw createMavioError("CANCELLED", "Publication denied.");
      }

      return result();
    },

    async dispose() {
      calls.push("dispose");
      await overrides.dispose?.();
      bytes.fill(0);
    },
  };

  const client = createCapabilityClient(engine);
  const input = { kind: "bytes", bytes: new Uint8Array([1]) };

  const video = () =>
    client.from(input).convert({
      format: "mp4",
      preset: "video-balanced-v1",
    });

  return { client, input, calls, video };
}

test("export and thumbnail execute in order and outputs survive disposal", async () => {
  const warnings = [{ code: "CLEANUP_FAILED", message: "Temporary file remains." }];
  const { client, input, calls, video } = fixture({ warnings });

  const exported = await video().export({ output: { kind: "bytes" } });
  const image = await client.from(input).thumbnail({
    at: 1,
    format: "jpeg",
    preset: "jpeg-balanced-v1",
    output: { kind: "bytes" },
  });

  assert.deepEqual(calls, [
    "initialize",
    "capabilities",
    "probe",
    "supports",
    "execute",
    "probe",
    "supports",
    "execute",
  ]);
  assert.notEqual(exported.jobId, image.jobId);
  assert.deepEqual(exported.engine, { id: "execution-mock", version: "test" });

  warnings[0].message = "Changed later.";
  assert.equal(exported.warnings[0].message, "Temporary file remains.");

  await client.dispose();
  assert.deepEqual([...exported.output.bytes], [7, 8]);
  assert.deepEqual([...image.output.bytes], [7, 8]);
});

test("capability, source, and support failures never reach execute", async () => {
  const cases = [
    [{ encodings: [] }, false, "UNSUPPORTED_CAPABILITY"],
    [{}, true, "INVALID_OPTIONS"],
    [{ support: { status: "unsupported", issues: [] } }, false, "UNSUPPORTED_CAPABILITY"],
    [{ support: { status: "unknown", issues: [] } }, false, "UNSUPPORTED_CAPABILITY"],
  ];

  for (const [overrides, invalidTrim, code] of cases) {
    const { client, calls, video } = fixture(overrides);
    const pipeline = invalidTrim ? video().trim({ start: 0, end: 11 }) : video();

    await assert.rejects(pipeline.export({ output: { kind: "bytes" } }), { code });

    assert.equal(calls.includes("execute"), false);
    await client.dispose();
  }
});

test("cancellation before publication waits for engine cleanup", async () => {
  const entered = deferred();
  const cleaning = deferred();
  const cleaned = deferred();
  const controller = new AbortController();
  let published = false;

  const { client, video } = fixture({
    async execute(_plan, context) {
      await new Promise((resolve) => {
        context.signal.addEventListener("abort", resolve, { once: true });
        entered.resolve();
      });

      published = context.beginCommit();
      throw createMavioError("CANCELLED", "Stopped before publication.");
    },
    async dispose() {
      cleaning.resolve();
      await cleaned.promise;
    },
  });

  let settled = false;
  const pending = video().export({ output: { kind: "bytes" } }, { signal: controller.signal });
  const observed = pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const rejected = assert.rejects(pending, { code: "CANCELLED" });

  await entered.promise;
  controller.abort();
  await cleaning.promise;

  assert.equal(published, false);
  assert.equal(settled, false);

  cleaned.resolve();
  await Promise.all([observed, rejected]);
  await client.dispose();
});

test("late cancellation and disposal wait for authorized publication", async () => {
  const authorized = deferred();
  const publication = deferred();
  const controller = new AbortController();
  let executionSignal;

  const { client, video } = fixture({
    async execute(_plan, context, result) {
      executionSignal = context.signal;
      assert.equal(context.beginCommit(), true);
      authorized.resolve();
      await publication.promise;
      return result();
    },
  });

  const pending = video().export({ output: { kind: "bytes" } }, { signal: controller.signal });

  await authorized.promise;
  controller.abort();

  let disposed = false;
  const disposal = client.dispose().then(() => {
    disposed = true;
  });

  await Promise.resolve();
  assert.equal(executionSignal.aborted, false);
  assert.equal(disposed, false);

  publication.resolve();

  const result = await pending;
  await disposal;
  assert.deepEqual([...result.output.bytes], [7, 8]);
});

test("missing publication permission and mismatched outputs are rejected", async () => {
  for (const mismatch of [false, true]) {
    const { client, video } = fixture({
      async execute(_plan, context, result) {
        if (!mismatch) return result();

        assert.equal(context.beginCommit(), true);
        return {
          ...result(),
          output: { kind: "blob", blob: new Blob(["wrong kind"]) },
        };
      },
    });

    await assert.rejects(video().export({ output: { kind: "bytes" } }), (error) => {
      assert.equal(error.code, "EXECUTION_FAILED");
      assert.equal(
        error.details.reason,
        mismatch ? "OUTPUT_KIND_MISMATCH" : "COMMIT_GATE_REQUIRED",
      );
      return true;
    });

    await client.dispose();
  }
});

test("execution failure remains primary when cleanup also fails", async () => {
  const { client, video } = fixture({
    async execute() {
      throw createMavioError("IO_ERROR", "Output storage unavailable.");
    },
    async dispose() {
      throw new Error("Cleanup failed.");
    },
  });

  await assert.rejects(video().export({ output: { kind: "bytes" } }), (error) => {
    assert.equal(error.code, "IO_ERROR");
    assert.equal(error.cleanupIssues.length, 1);
    return true;
  });

  await assert.rejects(client.capabilities(), { code: "ENGINE_UNAVAILABLE" });
  await assert.rejects(client.dispose(), { code: "CLEANUP_FAILED" });
});

test("gate acquisition does not turn a publication failure into success", async () => {
  let executions = 0;
  const { client, video } = fixture({
    async execute(_plan, context, result) {
      executions += 1;
      assert.equal(context.beginCommit(), true);

      if (executions === 1) {
        throw createMavioError("OUTPUT_EXISTS", "Destination became occupied.");
      }

      return result();
    },
  });

  await assert.rejects(video().export({ output: { kind: "bytes" } }), { code: "OUTPUT_EXISTS" });
  assert.equal(executions, 1);

  await video().export({ output: { kind: "bytes" } });
  assert.equal(executions, 2);
  await client.dispose();
});
