import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { createCapabilityClient } from "../../dist/core/capability-client.js";
import { BROWSER_RUNTIME } from "../../dist/core/runtime.js";
import { createNodeRuntime } from "../../dist/runtime/node.js";

function fixture(runtime = createNodeRuntime()) {
  const calls = [];
  const inputs = [];
  const plans = [];

  const engine = {
    id: "path-mock",
    runtime: runtime.runtime,

    async initialize() {
      calls.push("initialize");
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
    client: createCapabilityClient(engine, {}, runtime),
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
