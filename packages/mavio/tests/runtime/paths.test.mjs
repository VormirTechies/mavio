import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { createCapabilityClient } from "../../dist/core/capability-client.js";
import { BROWSER_RUNTIME } from "../../dist/core/runtime.js";
import { createNodeRuntime } from "../../dist/runtime/node.js";

function fixture(runtime = createNodeRuntime(), options = {}) {
  const calls = [];
  const inputs = [];
  const plans = [];

  const engine = {
    id: "path-mock",
    runtime: runtime.runtime,

    async initialize() {
      calls.push("initialize");
      await options.initialize?.();
    },

    async capabilities() {
      return {
        engineId: "path-mock",
        engineVersion: "test",
        runtime: runtime.runtime,
        operations: ["metadata", "convert"],
        inputKinds: ["bytes", "path"],
        outputKinds: ["bytes", "path"],
        readableContainers: [],
        decoders: [],
        encodings: [
          {
            container: "mp4",
            preset: "video-balanced-v1",
          },
        ],
        limits: {},
      };
    },

    async probe(input) {
      inputs.push(input);
      return {
        durationSeconds: 2,
        streams: [{ index: 0, kind: "video" }],
      };
    },

    async supports() {
      return { status: "supported" };
    },

    async execute(plan, context) {
      plans.push(plan);
      assert.equal(context.beginCommit(), true);

      return {
        output:
          plan.output.kind === "path"
            ? { kind: "path", path: plan.output.path }
            : { kind: "bytes", bytes: new Uint8Array([9]) },
        metadata: { streams: [] },
      };
    },

    async dispose() {},
  };

  return {
    client: createCapabilityClient(engine, { maxQueuedJobs: options.maxQueuedJobs }, runtime),
    calls,
    inputs,
    plans,
  };
}

function video(
  client,
  input = {
    kind: "bytes",
    bytes: new Uint8Array([1]),
  },
) {
  return client.from(input).convert({
    format: "mp4",
    preset: "video-balanced-v1",
  });
}

test("Node resolution uses the captured directory after cwd changes", () => {
  const original = process.cwd();
  const runtime = createNodeRuntime();

  try {
    process.chdir(tmpdir());
    assert.equal(runtime.resolvePath("media/clip.mp4"), resolve(original, "media/clip.mp4"));
  } finally {
    process.chdir(original);
  }
});

test("absolute paths remain absolute and preserve spaces", () => {
  const runtime = createNodeRuntime();
  const absolute = resolve("media folder", "clip name.mp4");

  assert.equal(runtime.resolvePath(absolute), absolute);
});

test("metadata passes a captured absolute input path to the engine", async () => {
  const original = process.cwd();
  const { client, inputs, calls } = fixture();
  const pipeline = client.from({ kind: "path", path: "missing clip.mp4" });

  assert.deepEqual(calls, []);

  try {
    process.chdir(tmpdir());
    await pipeline.metadata();

    assert.deepEqual(inputs[0], {
      kind: "path",
      path: resolve(original, "missing clip.mp4"),
    });
  } finally {
    process.chdir(original);
    await client.dispose();
  }
});

test("export resolves both paths and returns the engine's absolute target", async () => {
  const base = process.cwd();
  const { client, plans } = fixture();

  const result = await video(client, {
    kind: "path",
    path: "input.mp4",
  }).export({
    output: { kind: "path", path: "results/output.mp4" },
  });

  assert.equal(plans[0].input.path, resolve(base, "input.mp4"));
  assert.equal(plans[0].output.path, resolve(base, "results/output.mp4"));
  assert.equal(result.output.path, resolve(base, "results/output.mp4"));

  await client.dispose();
});

test("browser path inputs and outputs fail before admission", async () => {
  const { client, calls } = fixture(BROWSER_RUNTIME);
  const events = [];
  const execution = { onProgress: (event) => events.push(event) };

  await assert.rejects(client.from({ kind: "path", path: "input.mp4" }).metadata(execution), {
    code: "UNSUPPORTED_CAPABILITY",
  });

  await assert.rejects(
    video(client).export(
      {
        output: { kind: "path", path: "output.mp4" },
      },
      execution,
    ),
    { code: "UNSUPPORTED_CAPABILITY" },
  );

  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
  await client.dispose();
});

test("resolver failures distinguish input errors from output option errors", async () => {
  const { client, calls } = fixture({
    runtime: "node",
    resolvePath() {
      throw new Error("Cannot resolve.");
    },
  });

  await assert.rejects(client.from({ kind: "path", path: "input.mp4" }).metadata(), {
    code: "INVALID_INPUT",
  });

  await assert.rejects(
    video(client).export({
      output: { kind: "path", path: "output.mp4" },
    }),
    { code: "INVALID_OPTIONS" },
  );

  assert.deepEqual(calls, []);
  await client.dispose();
});

test("runtime mismatch is rejected at client creation", () => {
  assert.throws(
    () =>
      createCapabilityClient({ id: "wrong-runtime", runtime: "browser" }, {}, createNodeRuntime()),
    { code: "UNSUPPORTED_RUNTIME" },
  );
});

test("drive-relative syntax follows the declared platform policy", () => {
  const runtime = createNodeRuntime();

  if (process.platform === "win32") {
    assert.throws(() => runtime.resolvePath("C:clip.mp4"), /Drive-relative/);
    assert.throws(() => runtime.resolvePath("C:"), /Drive-relative/);
  } else {
    assert.equal(runtime.resolvePath("C:clip.mp4"), resolve(process.cwd(), "C:clip.mp4"));
  }
});

function preAdmission(code) {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal(error.stage, "queued");
    assert.equal(error.jobId, undefined);
    return true;
  };
}

test("Node Blob inputs fail before admission for metadata and export", async () => {
  const { client, calls } = fixture();
  const input = { kind: "blob", blob: new Blob(["input"]) };
  const events = [];
  const execution = { onProgress: (event) => events.push(event) };

  try {
    const pipeline = client.from(input);
    assert.deepEqual(calls, []);

    await assert.rejects(pipeline.metadata(execution), preAdmission("UNSUPPORTED_CAPABILITY"));

    await assert.rejects(
      video(client, input).export({ output: { kind: "bytes" } }, execution),
      preAdmission("UNSUPPORTED_CAPABILITY"),
    );

    assert.deepEqual(calls, []);
    assert.deepEqual(events, []);
  } finally {
    await client.dispose();
  }
});

test("Node Blob outputs fail before admission for export and thumbnail", async () => {
  const { client, calls } = fixture();
  const events = [];
  const execution = { onProgress: (event) => events.push(event) };

  try {
    await assert.rejects(
      video(client).export({ output: { kind: "blob" } }, execution),
      preAdmission("UNSUPPORTED_CAPABILITY"),
    );

    await assert.rejects(
      client.from({ kind: "bytes", bytes: new Uint8Array([1]) }).thumbnail(
        {
          at: 0,
          format: "jpeg",
          preset: "jpeg-balanced-v1",
          output: { kind: "blob" },
        },
        execution,
      ),
      preAdmission("UNSUPPORTED_CAPABILITY"),
    );

    assert.deepEqual(calls, []);
    assert.deepEqual(events, []);
  } finally {
    await client.dispose();
  }
});

test("disposal and pre-aborted signals take precedence over runtime compatibility", async () => {
  const { client, calls } = fixture();
  const pipeline = video(client);
  const controller = new AbortController();
  const events = [];

  controller.abort();

  const execution = {
    signal: controller.signal,
    onProgress: (event) => events.push(event),
  };

  try {
    await assert.rejects(
      pipeline.export({ output: { kind: "blob" } }, execution),
      preAdmission("CANCELLED"),
    );

    await client.dispose();

    await assert.rejects(
      pipeline.export({ output: { kind: "blob" } }, execution),
      preAdmission("DISPOSED"),
    );

    assert.deepEqual(calls, []);
    assert.deepEqual(events, []);
  } finally {
    await client.dispose();
  }
});

test("terminal validation and static conflicts precede runtime compatibility", async () => {
  const { client, calls } = fixture();
  const input = { kind: "blob", blob: new Blob(["input"]) };
  const events = [];
  const execution = { onProgress: (event) => events.push(event) };

  try {
    await assert.rejects(
      video(client, input).export({ output: { kind: "invalid" } }, execution),
      preAdmission("INVALID_OPTIONS"),
    );

    await assert.rejects(
      client.from(input).trim({ start: 0, end: 1 }).metadata(execution),
      preAdmission("INVALID_OPTIONS"),
    );

    assert.deepEqual(calls, []);
    assert.deepEqual(events, []);
  } finally {
    await client.dispose();
  }
});

test("runtime incompatibility takes precedence over a full queue", async () => {
  for (const runtime of [createNodeRuntime(), BROWSER_RUNTIME]) {
    let release;
    let started;

    const gate = new Promise((resolveGate) => {
      release = resolveGate;
    });

    const entered = new Promise((resolveEntered) => {
      started = resolveEntered;
    });

    const { client, calls } = fixture(runtime, {
      maxQueuedJobs: 0,
      async initialize() {
        started();
        await gate;
      },
    });

    const active = client.capabilities();

    try {
      await entered;

      const events = [];
      const execution = { onProgress: (event) => events.push(event) };
      const output =
        runtime.runtime === "node" ? { kind: "blob" } : { kind: "path", path: "output.mp4" };

      await assert.rejects(
        video(client).export({ output }, execution),
        preAdmission("UNSUPPORTED_CAPABILITY"),
      );

      // A runtime-compatible submission reaches the capacity check.
      await assert.rejects(
        video(client).export({ output: { kind: "bytes" } }, execution),
        preAdmission("QUEUE_FULL"),
      );

      assert.deepEqual(events, []);
      assert.deepEqual(calls, ["initialize"]);
    } finally {
      release();
      await active;
      await client.dispose();
    }
  }
});

test("Node Buffer input remains accepted without replacing caller storage", async () => {
  const { client, inputs } = fixture();
  const bytes = Buffer.from([1, 2]);

  try {
    await client.from({ kind: "bytes", bytes }).metadata();

    assert.equal(inputs[0].kind, "bytes");
    assert.equal(inputs[0].bytes, bytes);
    assert.deepEqual([...bytes], [1, 2]);
  } finally {
    await client.dispose();
  }
});
