import assert from "node:assert/strict";
import test from "node:test";
import { createMavio } from "@vormir/mavio/node";
import {
  captureCapabilities,
  captureExecutionResult,
  captureMetadata,
  captureSupportResult,
} from "../../dist/core/adapter-response.js";

function capabilities() {
  return {
    engineId: "response-mock",
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
}

function adapter(overrides = {}) {
  return {
    id: "response-mock",
    runtime: "node",
    async initialize() {},
    async capabilities() {
      return capabilities();
    },
    async probe() {
      return { streams: [] };
    },
    async supports() {
      return { status: "supported" };
    },
    async execute() {
      throw new Error("Unexpected execution.");
    },
    async dispose() {},
    ...overrides,
  };
}

test("valid capabilities are captured independently", () => {
  const original = capabilities();
  const result = captureCapabilities(original, adapter());

  original.operations.push("trim");
  original.limits.maxWidth = 1;

  assert.deepEqual(result.operations, ["metadata", "convert"]);
  assert.deepEqual(result.limits, {});
});

test("malformed capabilities produce stable contract diagnostics", () => {
  const cases = [
    null,
    {},
    { ...capabilities(), engineId: "another-engine" },
    { ...capabilities(), runtime: "browser" },
    { ...capabilities(), operations: ["invented-operation"] },
    { ...capabilities(), inputKinds: "bytes" },
    { ...capabilities(), encodings: [null] },
    { ...capabilities(), limits: { maxWidth: -1 } },
    { ...capabilities(), extra: () => {} },
  ];

  for (const value of cases) {
    assert.throws(
      () => captureCapabilities(value, adapter()),
      (error) => {
        assert.equal(error.code, "ENGINE_INIT_FAILED");
        assert.equal(error.details.reason, "ENGINE_CONTRACT_VIOLATION");
        assert.equal(error.details.response, "capabilities");
        assert.equal(typeof error.details.field, "string");
        return true;
      },
    );
  }
});

test("metadata accepts unknown optional values by omission and copies streams", () => {
  assert.deepEqual(captureMetadata({ streams: [] }), { streams: [] });

  const original = {
    durationSeconds: 0,
    streams: [
      {
        index: 2,
        kind: "video",
        width: 320,
        height: 180,
        rotationDegrees: -90,
        frameRate: { numerator: 30000, denominator: 1001 },
      },
    ],
  };

  const result = captureMetadata(original);
  original.streams[0].width = 999;

  assert.equal(result.streams[0].width, 320);
  assert.equal(result.streams[0].index, 2);
});

test("malformed metadata is rejected rather than returned as media data", () => {
  const cases = [
    null,
    {},
    { streams: "invalid" },
    { streams: [null] },
    { streams: [], durationSeconds: NaN },
    { streams: [], sizeBytes: -1 },
    { streams: [{ index: 0, kind: "unknown" }] },
    { streams: [{ index: 0, kind: "video", width: 0 }] },
    {
      streams: [
        { index: 0, kind: "video" },
        { index: 0, kind: "audio" },
      ],
    },
    {
      streams: [
        {
          index: 0,
          kind: "video",
          frameRate: { numerator: 30, denominator: 0 },
        },
      ],
    },
  ];

  for (const value of cases) {
    assert.throws(
      () => captureMetadata(value),
      (error) => {
        assert.equal(error.code, "EXECUTION_FAILED");
        assert.equal(error.details.reason, "ENGINE_CONTRACT_VIOLATION");
        assert.equal(error.details.response, "metadata");
        return true;
      },
    );
  }
});

test("invalid capabilities are cleaned up and never cached", async () => {
  let attempts = 0;
  let cleanups = 0;

  const client = createMavio({
    engine: adapter({
      async capabilities() {
        attempts += 1;
        return attempts === 1 ? {} : capabilities();
      },
      async dispose() {
        cleanups += 1;
      },
    }),
  });

  try {
    await assert.rejects(client.capabilities(), (error) => {
      assert.equal(error.code, "ENGINE_INIT_FAILED");
      assert.equal(error.stage, "preparing");
      assert.equal(error.details.reason, "ENGINE_CONTRACT_VIOLATION");
      assert.equal(error.details.response, "capabilities");
      return true;
    });

    assert.equal(cleanups, 1);

    const result = await client.capabilities();
    assert.equal(result.engineId, "response-mock");
    assert.equal(attempts, 2);
  } finally {
    await client.dispose();
  }
});

test("invalid probe metadata fails both metadata and export before encoding", async () => {
  for (const operation of ["metadata", "export"]) {
    let supports = 0;
    let executions = 0;
    let cleanups = 0;

    const client = createMavio({
      engine: adapter({
        async probe() {
          return { streams: "invalid" };
        },
        async supports() {
          supports += 1;
          return { status: "supported" };
        },
        async execute() {
          executions += 1;
          throw new Error("Encoding must not start.");
        },
        async dispose() {
          cleanups += 1;
        },
      }),
    });

    try {
      const pipeline = client.from({
        kind: "bytes",
        bytes: new Uint8Array([1]),
      });

      const pending =
        operation === "metadata"
          ? pipeline.metadata()
          : pipeline
              .convert({ format: "mp4", preset: "video-balanced-v1" })
              .export({ output: { kind: "bytes" } });

      await assert.rejects(pending, (error) => {
        assert.equal(error.code, "EXECUTION_FAILED");
        assert.equal(error.details.reason, "ENGINE_CONTRACT_VIOLATION");
        assert.equal(error.details.response, "metadata");
        assert.equal(error.stage, operation === "metadata" ? "running" : "preparing");
        return true;
      });

      assert.equal(supports, 0);
      assert.equal(executions, 0);
      assert.equal(cleanups, 1);
    } finally {
      await client.dispose();
    }
  }
});

test("support responses preserve valid statuses and independent issue snapshots", () => {
  assert.deepEqual(captureSupportResult({ status: "supported" }), {
    status: "supported",
  });

  for (const status of ["unsupported", "unknown"]) {
    const original = {
      status,
      issues: [
        {
          code: "CODEC_UNAVAILABLE",
          message: "Encoder unavailable.",
          operation: "convert",
        },
      ],
    };

    const result = captureSupportResult(original);
    original.issues[0].message = "Changed later.";

    assert.equal(result.status, status);
    assert.equal(result.issues[0].message, "Encoder unavailable.");
  }
});

test("malformed support responses are contract violations", () => {
  const cases = [
    null,
    {},
    { status: "typo" },
    { status: "unknown" },
    { status: "unsupported", issues: "invalid" },
    { status: "unknown", issues: [null] },
    { status: "unknown", issues: [{ code: 42, message: "Invalid." }] },
    {
      status: "unknown",
      issues: [{ code: "X", message: "Invalid.", operation: "invented" }],
    },
  ];

  for (const value of cases) {
    assert.throws(
      () => captureSupportResult(value),
      (error) => {
        assert.equal(error.code, "EXECUTION_FAILED");
        assert.equal(error.details.reason, "ENGINE_CONTRACT_VIOLATION");
        assert.equal(error.details.response, "support");
        return true;
      },
    );
  }
});

test("execution results retain independent bytes, metadata, and warnings", () => {
  for (const shared of [false, true]) {
    const bytes = shared ? new Uint8Array(new SharedArrayBuffer(2)) : new Uint8Array(2);
    bytes.set([7, 8]);

    const original = {
      output: { kind: "bytes", bytes },
      metadata: { streams: [{ index: 0, kind: "video", width: 320 }] },
      warnings: [{ code: "CLEANUP_FAILED", message: "Temporary file remains." }],
    };

    const result = captureExecutionResult(original, { kind: "bytes" });

    bytes.fill(0);
    original.metadata.streams[0].width = 999;
    original.warnings[0].message = "Changed later.";

    assert.deepEqual([...result.output.bytes], [7, 8]);
    assert.equal(result.metadata.streams[0].width, 320);
    assert.equal(result.warnings[0].message, "Temporary file remains.");
  }
});

test("malformed execution results have consistent field diagnostics", () => {
  const valid = {
    output: { kind: "bytes", bytes: new Uint8Array([1]) },
    metadata: { streams: [] },
  };

  const cases = [
    [null, "$"],
    [{}, "$.output"],
    [{ ...valid, output: { kind: "blob", blob: new Blob(["x"]) } }, "$.output.kind"],
    [{ ...valid, output: { kind: "bytes", bytes: new Uint8Array() } }, "$.output.bytes"],
    [{ ...valid, metadata: null }, "$.metadata"],
    [{ ...valid, warnings: "invalid" }, "$.warnings"],
    [{ ...valid, warnings: [{ code: "WRONG_CODE", message: "Invalid." }] }, "$.warnings[0].code"],
  ];

  for (const [value, field] of cases) {
    assert.throws(
      () => captureExecutionResult(value, { kind: "bytes" }),
      (error) => {
        assert.equal(error.code, "EXECUTION_FAILED");
        assert.equal(error.details.reason, "ENGINE_CONTRACT_VIOLATION");
        assert.equal(error.details.response, "execution");
        assert.equal(error.details.field, field);
        return true;
      },
    );
  }
});

function exportVideo(client, execution) {
  return client
    .from({ kind: "bytes", bytes: new Uint8Array([1]) })
    .convert({ format: "mp4", preset: "video-balanced-v1" })
    .export({ output: { kind: "bytes" } }, execution);
}

test("malformed support fails before encoding and cleans up the session", async () => {
  let executions = 0;
  let cleanups = 0;

  const client = createMavio({
    engine: adapter({
      async probe() {
        return { streams: [{ index: 0, kind: "video" }] };
      },
      async supports() {
        return { status: "typo" };
      },
      async execute() {
        executions += 1;
        throw new Error("Encoding must not start.");
      },
      async dispose() {
        cleanups += 1;
      },
    }),
  });

  try {
    await assert.rejects(exportVideo(client), (error) => {
      assert.equal(error.code, "EXECUTION_FAILED");
      assert.equal(error.stage, "preparing");
      assert.equal(error.details.response, "support");
      return true;
    });

    assert.equal(executions, 0);
    assert.equal(cleanups, 1);
  } finally {
    await client.dispose();
  }
});

test("malformed execution metadata is rejected and the session is reset", async () => {
  let cleanups = 0;

  const client = createMavio({
    engine: adapter({
      async probe() {
        return { streams: [{ index: 0, kind: "video" }] };
      },
      async execute(_plan, context) {
        assert.equal(context.beginCommit(), true);

        return {
          output: { kind: "bytes", bytes: new Uint8Array([1]) },
          metadata: null,
        };
      },
      async dispose() {
        cleanups += 1;
      },
    }),
  });

  try {
    await assert.rejects(exportVideo(client), (error) => {
      assert.equal(error.code, "EXECUTION_FAILED");
      assert.equal(error.stage, "finalizing");
      assert.equal(error.details.response, "execution");
      assert.equal(error.details.field, "$.metadata");
      return true;
    });

    assert.equal(cleanups, 1);
  } finally {
    await client.dispose();
  }
});

test("valid cleanup warnings remain successful after a late abort", async () => {
  const controller = new AbortController();
  const events = [];

  const client = createMavio({
    engine: adapter({
      async probe() {
        return { streams: [{ index: 0, kind: "video" }] };
      },
      async execute(_plan, context) {
        assert.equal(context.beginCommit(), true);
        controller.abort();

        return {
          output: { kind: "bytes", bytes: new Uint8Array([7]) },
          metadata: { streams: [] },
          warnings: [{ code: "CLEANUP_FAILED", message: "Temporary file remains." }],
        };
      },
    }),
  });

  try {
    const result = await exportVideo(client, {
      signal: controller.signal,
      onProgress: (event) => events.push(event),
    });

    assert.deepEqual([...result.output.bytes], [7]);
    assert.equal(result.warnings[0].code, "CLEANUP_FAILED");
    assert.equal(events.at(-1).stage, "completed");
    assert.equal(
      events.some((event) => event.stage === "cancelled"),
      false,
    );
  } finally {
    await client.dispose();
  }
});
