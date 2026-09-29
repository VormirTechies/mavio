import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createMavio as createRoot } from "@vormir/mavio";
import { createMavio as createNode } from "@vormir/mavio/node";
import { createMavio as createBrowser } from "@vormir/mavio/browser";

function fixture(runtime = "node") {
  const calls = [];
  const inputs = [];

  const engine = {
    id: `factory-${runtime}`,
    runtime,

    async initialize() {
      calls.push("initialize");
    },

    async capabilities() {
      calls.push("capabilities");

      return {
        engineId: engine.id,
        engineVersion: "test",
        runtime,
        operations: ["metadata"],
        inputKinds: runtime === "node" ? ["bytes", "path"] : ["bytes"],
        outputKinds: ["bytes"],
        readableContainers: [],
        decoders: [],
        encodings: [],
        limits: {},
      };
    },

    async probe(input) {
      calls.push("probe");
      inputs.push(input);
      return { durationSeconds: 2, streams: [] };
    },

    async supports() {
      return { status: "supported" };
    },

    async execute() {
      throw new Error("Unexpected execution.");
    },

    async dispose() {
      calls.push("dispose");
    },
  };

  return { engine, calls, inputs };
}

test("root factory is lazy and supports metadata through the Node entry", async () => {
  const { engine, calls } = fixture();
  const client = createRoot({ engine });

  try {
    const pipeline = client.from({
      kind: "bytes",
      bytes: new Uint8Array([1]),
    });

    assert.deepEqual(calls, []);

    const result = await pipeline.metadata();

    assert.equal(result.durationSeconds, 2);
    assert.deepEqual(calls, ["initialize", "capabilities", "probe"]);
  } finally {
    await client.dispose();
  }

  assert.deepEqual(calls, ["initialize", "capabilities", "probe", "dispose"]);
});

test("Node factory supplies absolute path resolution", async () => {
  const { engine, inputs } = fixture();
  const client = createNode({ engine });

  try {
    await client.from({ kind: "path", path: "fixture.mp4" }).metadata();

    assert.equal(inputs[0].path, path.resolve("fixture.mp4"));
  } finally {
    await client.dispose();
  }
});

test("browser factory rejects paths before initialization", async () => {
  const { engine, calls } = fixture("browser");
  const client = createBrowser({ engine });

  try {
    await assert.rejects(client.from({ kind: "path", path: "fixture.mp4" }).metadata(), {
      code: "UNSUPPORTED_CAPABILITY",
      stage: "queued",
    });

    assert.deepEqual(calls, []);
  } finally {
    await client.dispose();
  }
});

test("factory rejects malformed options and adapters synchronously", () => {
  for (const options of [null, [], 42, "invalid"]) {
    assert.throws(() => createNode(options), { code: "INVALID_OPTIONS" });
  }

  for (const engine of [null, {}, "invalid", { id: "", runtime: "node" }]) {
    assert.throws(() => createNode({ engine }), { code: "INVALID_OPTIONS" });
  }

  for (const method of ["initialize", "capabilities", "probe", "supports", "execute", "dispose"]) {
    const { engine } = fixture();
    delete engine[method];

    assert.throws(() => createNode({ engine }), { code: "INVALID_OPTIONS" });
  }
});

test("invalid configuration does not claim an adapter", async () => {
  const { engine, calls } = fixture();

  for (const options of [
    { initTimeoutMs: 0 },
    { initTimeoutMs: null },
    { initTimeoutMs: Infinity },
    { maxQueuedJobs: -1 },
    { maxQueuedJobs: 1.5 },
    { maxQueuedJobs: null },
    { native: {} },
    { browser: {} },
  ]) {
    assert.throws(() => createNode({ engine, ...options }), {
      code: "INVALID_OPTIONS",
    });
  }

  assert.deepEqual(calls, []);

  const client = createNode({ engine, maxQueuedJobs: 0 });
  await client.dispose();
});

test("runtime mismatch does not claim an adapter", async () => {
  const { engine, calls } = fixture("browser");

  assert.throws(() => createNode({ engine }), {
    code: "UNSUPPORTED_RUNTIME",
  });

  assert.deepEqual(calls, []);

  const client = createBrowser({ engine });
  await client.dispose();
});

test("an adapter remains owned after its client is disposed", async () => {
  const { engine } = fixture();
  const client = createRoot({ engine });

  try {
    assert.throws(() => createNode({ engine }), {
      code: "INVALID_OPTIONS",
      details: { reason: "ENGINE_ALREADY_OWNED" },
    });
  } finally {
    await client.dispose();
  }

  assert.throws(() => createNode({ engine }), {
    code: "INVALID_OPTIONS",
    details: { reason: "ENGINE_ALREADY_OWNED" },
  });
});

test("default engines report the explicit M2 implementation limitation", () => {
  for (const create of [createRoot, createNode, createBrowser]) {
    for (const options of [undefined, {}, { engine: "auto" }]) {
      assert.throws(() => create(options), {
        code: "ENGINE_UNAVAILABLE",
        stage: "queued",
        details: { reason: "DEFAULT_ENGINE_NOT_IMPLEMENTED" },
      });
    }
  }
});
