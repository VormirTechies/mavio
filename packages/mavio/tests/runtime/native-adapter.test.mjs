import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createMavio } from "../../dist/node.js";
import { createMavioError } from "../../dist/core/errors.js";
import { createNativeEngine } from "../../dist/engines/native/adapter.js";
import { access, readFile } from "node:fs/promises";
import { createNativeWorkspace } from "../../dist/engines/native/workspace.js";

function context(signal = new AbortController().signal) {
  return {
    jobId: "native-adapter-test",
    signal,
    reportProgress() {},
  };
}

function fixture(overrides = {}) {
  const calls = [];

  const engine = createNativeEngine(
    {},
    {
      workspace: overrides.workspace,
      async prepare(configuration, ctx) {
        calls.push("prepare");
        if (overrides.prepare) {
          return overrides.prepare(configuration, ctx);
        }

        return {
          ffmpeg: { path: resolve("ffmpeg"), version: "test-ffmpeg" },
          ffprobe: { path: resolve("ffprobe"), version: "test-ffprobe" },
        };
      },

      async inventory() {
        calls.push("inventory");
        if (overrides.inventory) return overrides.inventory();

        return {
          encoders: ["libx264"],
          decoders: ["h264"],
          muxers: ["mp4"],
          demuxers: ["mov", "mp4"],
          filters: ["trim"],
        };
      },

      async probe(configuration, tools, path, ctx) {
        calls.push("probe");

        if (overrides.probe) {
          return overrides.probe(configuration, tools, path, ctx);
        }

        return {
          durationSeconds: 2,
          streams: [{ index: 0, kind: "video", codec: "h264" }],
        };
      },
    },
  );

  return { engine, calls };
}

test("native construction is lazy and advertises only implemented metadata support", async () => {
  const { engine, calls } = fixture();
  const client = createMavio({ engine });

  try {
    client.from({ kind: "path", path: "sample.mp4" });
    assert.deepEqual(calls, []);

    const capabilities = await client.capabilities();

    assert.deepEqual(calls, ["prepare", "inventory"]);
    assert.equal(capabilities.engineId, "native-ffmpeg");
    assert.deepEqual(capabilities.operations, ["metadata"]);
    assert.deepEqual(capabilities.inputKinds, ["path", "bytes"]);
    assert.deepEqual(capabilities.outputKinds, []);
    assert.deepEqual(capabilities.encodings, []);

    capabilities.operations.push("trim");

    const next = await client.capabilities();
    assert.deepEqual(next.operations, ["metadata"]);
    assert.deepEqual(calls, ["prepare", "inventory"]);
  } finally {
    await client.dispose();
  }
});

test("public metadata calls resolve paths and reuse native initialization", async () => {
  const paths = [];
  const source = {
    durationSeconds: 2,
    streams: [{ index: 0, kind: "video", codec: "h264" }],
  };

  const { engine, calls } = fixture({
    async probe(_configuration, _tools, path) {
      paths.push(path);
      return source;
    },
  });

  const client = createMavio({ engine });

  try {
    const pipeline = client.from({ kind: "path", path: "sample.mp4" });
    const first = await pipeline.metadata();
    first.streams[0].codec = "changed";

    const second = await pipeline.metadata();

    assert.equal(second.streams[0].codec, "h264");
    assert.deepEqual(paths, [resolve("sample.mp4"), resolve("sample.mp4")]);
    assert.deepEqual(calls, ["prepare", "inventory", "probe", "probe"]);
  } finally {
    await client.dispose();
  }
});

test("native metadata runs through the client's serial queue", async () => {
  let active = 0;
  let maximum = 0;

  const { engine } = fixture({
    async probe() {
      active += 1;
      maximum = Math.max(maximum, active);
      await setImmediate();
      active -= 1;
      return { streams: [] };
    },
  });

  const client = createMavio({ engine });

  try {
    await Promise.all([
      client.from({ kind: "path", path: "first.mp4" }).metadata(),
      client.from({ kind: "path", path: "second.mp4" }).metadata(),
    ]);

    assert.equal(maximum, 1);
    assert.equal(active, 0);
  } finally {
    await client.dispose();
  }
});

test("failed inventory does not publish partially initialized adapter state", async () => {
  let attempts = 0;

  const { engine } = fixture({
    async inventory() {
      attempts += 1;
      if (attempts === 1) throw new Error("Inventory failed");

      return {
        encoders: [],
        decoders: [],
        muxers: [],
        demuxers: [],
        filters: [],
      };
    },
  });

  await assert.rejects(engine.initialize(context()), /Inventory failed/);
  await assert.rejects(engine.capabilities(), {
    code: "ENGINE_INIT_FAILED",
    details: { reason: "NATIVE_NOT_INITIALIZED" },
  });

  await engine.dispose();
  await engine.initialize(context());

  assert.deepEqual((await engine.capabilities()).operations, ["metadata"]);
  await engine.dispose();
});

test("a failed public probe resets the adapter before the next job", async () => {
  let probes = 0;

  const { engine, calls } = fixture({
    async probe() {
      probes += 1;

      if (probes === 1) {
        throw createMavioError("EXECUTION_FAILED", "Probe failed.");
      }

      return { streams: [] };
    },
  });

  const client = createMavio({ engine });

  try {
    const pipeline = client.from({ kind: "path", path: "sample.mp4" });

    await assert.rejects(pipeline.metadata(), { code: "EXECUTION_FAILED" });
    assert.deepEqual(await pipeline.metadata(), { streams: [] });

    assert.deepEqual(calls, ["prepare", "inventory", "probe", "prepare", "inventory", "probe"]);
  } finally {
    await client.dispose();
  }
});

test("client disposal clears native state and rejects further jobs", async () => {
  const { engine } = fixture();
  const client = createMavio({ engine });

  await client.capabilities();
  await client.dispose();
  await client.dispose();

  await assert.rejects(engine.capabilities(), {
    code: "ENGINE_INIT_FAILED",
  });

  await assert.rejects(async () => client.capabilities(), { code: "DISPOSED" });
});

test("pre-aborted native initialization performs no discovery", async () => {
  const { engine, calls } = fixture();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(engine.initialize(context(controller.signal)), {
    code: "CANCELLED",
  });

  assert.deepEqual(calls, []);
});

test("unimplemented native inputs and processing remain unsupported", async () => {
  const { engine, calls } = fixture();
  await engine.initialize(context());

  await assert.rejects(engine.probe({ kind: "blob", blob: new Blob(["test"]) }, context()), {
    code: "UNSUPPORTED_CAPABILITY",
  });

  assert.equal((await engine.supports({}, {})).status, "unsupported");

  let commitCalls = 0;

  await assert.rejects(
    engine.execute(
      {},
      {
        ...context(),
        beginCommit() {
          commitCalls += 1;
          return true;
        },
      },
    ),
    {
      code: "UNSUPPORTED_CAPABILITY",
      details: { reason: "NATIVE_PROCESSING_PENDING" },
    },
  );

  assert.equal(commitCalls, 0);
  assert.deepEqual(calls, ["prepare", "inventory"]);
  await engine.dispose();
});

test("public byte metadata stages content and removes it before resolving", async () => {
  let stagedPath;

  const { engine } = fixture({
    async probe(_configuration, _tools, path) {
      stagedPath = path;
      assert.deepEqual([...(await readFile(path))], [1, 2, 3]);
      return { durationSeconds: 2, streams: [] };
    },
  });

  const client = createMavio({ engine });
  const bytes = new Uint8Array([1, 2, 3]);

  try {
    const result = await client
      .from({
        kind: "bytes",
        bytes,
        name: "../../ignored-name.mp4",
      })
      .metadata();

    assert.equal(result.durationSeconds, 2);
    assert.deepEqual([...bytes], [1, 2, 3]);
    await assert.rejects(access(stagedPath), { code: "ENOENT" });
  } finally {
    await client.dispose();
  }
});

test("staging failure still cleans up the workspace", async () => {
  let cleanups = 0;
  const failure = createMavioError("IO_ERROR", "Write failed.");

  const { engine, calls } = fixture({
    async workspace() {
      return {
        async writeInput() {
          throw failure;
        },
        async dispose() {
          cleanups += 1;
        },
      };
    },
  });

  const client = createMavio({ engine });

  try {
    await assert.rejects(
      client
        .from({
          kind: "bytes",
          bytes: new Uint8Array([1]),
        })
        .metadata(),
      { code: "IO_ERROR" },
    );

    assert.equal(cleanups, 1);
    assert.equal(calls.includes("probe"), false);
  } finally {
    await client.dispose();
  }
});

test("abort during workspace creation prevents staging and cleans up", async () => {
  const controller = new AbortController();
  let writes = 0;
  let cleanups = 0;

  const { engine } = fixture({
    async workspace() {
      controller.abort();

      return {
        async writeInput() {
          writes += 1;
          return resolve("unused.bin");
        },
        async dispose() {
          cleanups += 1;
        },
      };
    },
  });

  const client = createMavio({ engine });

  try {
    await assert.rejects(
      client
        .from({
          kind: "bytes",
          bytes: new Uint8Array([1]),
        })
        .metadata({ signal: controller.signal }),
      { code: "CANCELLED" },
    );

    assert.equal(writes, 0);
    assert.equal(cleanups, 1);
  } finally {
    await client.dispose();
  }
});

test("probe failure survives a later abort during cleanup", async () => {
  const controller = new AbortController();

  const { engine } = fixture({
    async workspace() {
      return {
        async writeInput() {
          return resolve("mock-input.bin");
        },
        async dispose() {
          controller.abort();
        },
      };
    },
    async probe() {
      throw createMavioError("EXECUTION_FAILED", "Primary probe failure.", {
        details: { reason: "PRIMARY_PROBE_FAILURE" },
      });
    },
  });

  const client = createMavio({ engine });

  try {
    await assert.rejects(
      client
        .from({
          kind: "bytes",
          bytes: new Uint8Array([1]),
        })
        .metadata({ signal: controller.signal }),
      {
        code: "EXECUTION_FAILED",
        details: { reason: "PRIMARY_PROBE_FAILURE" },
      },
    );
  } finally {
    await client.dispose();
  }
});

test("cleanup failure rejects metadata and session reset retries cleanup", async () => {
  let cleanups = 0;

  const { engine } = fixture({
    async workspace() {
      return {
        async writeInput() {
          return resolve("mock-input.bin");
        },
        async dispose() {
          cleanups += 1;

          if (cleanups === 1) {
            throw new Error("Temporary cleanup failure");
          }
        },
      };
    },
  });

  const client = createMavio({ engine });

  try {
    await assert.rejects(
      client
        .from({
          kind: "bytes",
          bytes: new Uint8Array([1]),
        })
        .metadata(),
      (error) => {
        assert.equal(error.code, "CLEANUP_FAILED");
        assert.ok(error.cleanupIssues.includes("Native input workspace cleanup failed."));
        return true;
      },
    );

    assert.equal(cleanups, 2);

    // Successful reset permits the next job to initialize again.
    const result = await client.from({ kind: "path", path: "sample.mp4" }).metadata();

    assert.equal(result.durationSeconds, 2);
  } finally {
    await client.dispose();
  }
});

test("byte metadata does not settle before asynchronous cleanup completes", async () => {
  const cleanupStarted = Promise.withResolvers();
  const allowCleanup = Promise.withResolvers();
  let settled = false;

  const { engine } = fixture({
    async workspace() {
      const workspace = await createNativeWorkspace();

      return {
        writeInput: (bytes, ctx) => workspace.writeInput(bytes, ctx),
        async dispose() {
          cleanupStarted.resolve();
          await allowCleanup.promise;
          await workspace.dispose();
        },
      };
    },
  });

  const client = createMavio({ engine });

  const pending = client
    .from({
      kind: "bytes",
      bytes: new Uint8Array([1]),
    })
    .metadata();

  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  try {
    await cleanupStarted.promise;
    assert.equal(settled, false);

    allowCleanup.resolve();
    await pending;
    assert.equal(settled, true);
  } finally {
    allowCleanup.resolve();
    await pending.catch(() => {});
    await client.dispose();
  }
});
