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
  const metadata = {
    durationSeconds: 5,
    streams: [{ index: 0, kind: "video", width: 320, height: 180 }],
  };

  const engine = {
    id: "metadata-mock",
    runtime: "node",

    async initialize() {
      calls.push("initialize");
    },

    async capabilities() {
      calls.push("capabilities");
      return {
        engineId: "metadata-mock",
        engineVersion: "test",
        runtime: "node",
        operations: ["metadata"],
        inputKinds: overrides.inputKinds ?? ["bytes"],
        outputKinds: ["bytes"],
        readableContainers: [],
        decoders: [],
        encodings: [],
        limits: {},
      };
    },

    async probe(input, context) {
      calls.push("probe");
      if (overrides.probe) return overrides.probe(input, context);
      return metadata;
    },

    async dispose() {
      calls.push("dispose");
      await overrides.dispose?.();
    },
  };

  const client = createCapabilityClient(engine);
  const input = { kind: "bytes", bytes: new Uint8Array([1, 2]) };
  return { client, input, calls, metadata };
}

test("from stays lazy and repeated metadata calls return independent snapshots", async () => {
  const { client, input, calls, metadata } = fixture();
  const pipeline = client.from(input);

  assert.deepEqual(calls, []);

  const first = await pipeline.metadata();
  first.streams[0].width = 999;

  const second = await pipeline.metadata();

  assert.equal(second.streams[0].width, 320);
  assert.equal(metadata.streams[0].width, 320);
  assert.deepEqual(calls, ["initialize", "capabilities", "probe", "probe"]);

  await client.dispose();
  assert.equal(second.durationSeconds, 5);
});

test("metadata and capability requests share one queue", async () => {
  const gate = deferred();
  const entered = deferred();
  const { client, input, calls } = fixture({
    async probe() {
      entered.resolve();
      await gate.promise;
      return { streams: [] };
    },
  });

  const metadata = client.from(input).metadata();
  await entered.promise;

  const events = [];
  const capabilities = client.capabilities({
    onProgress: (event) => events.push(event),
  });

  assert.deepEqual(
    events.map((event) => event.stage),
    ["queued"],
  );
  assert.deepEqual(calls, ["initialize", "capabilities", "probe"]);

  gate.resolve();
  await Promise.all([metadata, capabilities]);

  assert.equal(events.at(-1).stage, "completed");
  await client.dispose();
});

test("invalid metadata composition and pre-aborted calls never initialize", async () => {
  const { client, input, calls } = fixture();
  const events = [];
  const pipeline = client.from(input).trim({ start: 0, end: 1 });

  await assert.rejects(pipeline.metadata({ onProgress: (event) => events.push(event) }), {
    code: "INVALID_OPTIONS",
  });

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    pipeline.metadata({
      signal: controller.signal,
      onProgress: (event) => events.push(event),
    }),
    { code: "CANCELLED" },
  );

  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
  await client.dispose();
});

test("unsupported input kinds never reach the engine probe", async () => {
  const { client, input, calls } = fixture({ inputKinds: ["blob"] });

  await assert.rejects(client.from(input).metadata(), {
    code: "UNSUPPORTED_CAPABILITY",
    operation: "metadata",
  });

  assert.deepEqual(calls, ["initialize", "capabilities"]);
  await client.dispose();
});

test("probe failure cleans up before a queued job reinitializes", async () => {
  const cleaning = deferred();
  const cleaned = deferred();
  let probes = 0;

  const { client, input, calls } = fixture({
    async probe() {
      probes += 1;
      if (probes === 1) {
        throw createMavioError("INVALID_MEDIA", "Malformed sample.");
      }
      return { streams: [] };
    },
    async dispose() {
      cleaning.resolve();
      await cleaned.promise;
    },
  });

  const first = client.from(input).metadata();
  const rejected = assert.rejects(first, {
    code: "INVALID_MEDIA",
    operation: "metadata",
  });
  const second = client.from(input).metadata();

  await cleaning.promise;
  assert.equal(probes, 1);
  cleaned.resolve();

  await rejected;
  await second;

  assert.deepEqual(calls, [
    "initialize",
    "capabilities",
    "probe",
    "dispose",
    "initialize",
    "capabilities",
    "probe",
  ]);

  await client.dispose();
});

test("active probe cancellation waits for cleanup before the next job", async () => {
  const entered = deferred();
  const cleaning = deferred();
  const cleaned = deferred();
  const controller = new AbortController();
  let probes = 0;

  const { client, input } = fixture({
    async probe(_input, context) {
      probes += 1;
      if (probes === 1) {
        await new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("Probe stopped.")), {
            once: true,
          });
          entered.resolve();
        });
      }
      return { streams: [] };
    },
    async dispose() {
      cleaning.resolve();
      await cleaned.promise;
    },
  });

  const active = client.from(input).metadata({ signal: controller.signal });
  const rejected = assert.rejects(active, { code: "CANCELLED" });

  await entered.promise;
  const next = client.from(input).metadata();
  controller.abort();

  await cleaning.promise;
  assert.equal(probes, 1);

  cleaned.resolve();
  await rejected;
  await next;

  assert.equal(probes, 2);
  await client.dispose();
});

test("existing pipelines and new builders respect client disposal", async () => {
  const { client, input, calls } = fixture();
  const pipeline = client.from(input);

  await client.dispose();

  assert.throws(() => client.from(input), { code: "DISPOSED" });
  assert.throws(() => pipeline.trim({ start: 0, end: 1 }), { code: "DISPOSED" });
  await assert.rejects(pipeline.metadata(), { code: "DISPOSED" });
  assert.deepEqual(calls, []);
});

test("cleanup failure preserves the probe error and prevents unsafe reuse", async () => {
  const { client, input, calls } = fixture({
    async probe() {
      throw createMavioError("INVALID_MEDIA", "Malformed sample.");
    },
    async dispose() {
      throw new Error("Cleanup failed.");
    },
  });

  await assert.rejects(client.from(input).metadata(), (error) => {
    assert.equal(error.code, "INVALID_MEDIA");
    assert.equal(error.cleanupIssues.length, 1);
    return true;
  });

  await assert.rejects(client.from(input).metadata(), {
    code: "ENGINE_UNAVAILABLE",
  });
  assert.equal(calls.filter((call) => call === "probe").length, 1);

  await assert.rejects(client.dispose(), { code: "CLEANUP_FAILED" });
});
