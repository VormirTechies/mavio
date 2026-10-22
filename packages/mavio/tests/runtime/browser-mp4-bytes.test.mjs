import assert from "node:assert/strict";
import test from "node:test";
import { prepareBrowserMp4Bytes } from "../../dist/engines/browser/mp4-bytes.js";
import { createMavioError } from "../../dist/core/errors.js";

function fixture(options = {}) {
  const files = new Map();
  const directories = new Set();
  const calls = [];

  const encoded = new Uint8Array(64);
  new DataView(encoded.buffer).setUint32(0, 24, false);
  encoded.set(new TextEncoder().encode("ftyp"), 4);
  encoded.set(new TextEncoder().encode("isom"), 8);
  encoded.set(new TextEncoder().encode("isomiso2"), 16);

  function report(output) {
    return {
      format: {
        format_name: "mov,mp4,m4a,3gp,3g2,mj2",
        duration: "1",
        size: output ? String(options.outputSize ?? 64) : "3",
        start_time: "0",
      },
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: "h264",
          width: output ? (options.outputWidth ?? 320) : 320,
          height: output ? (options.outputHeight ?? 180) : 180,
          pix_fmt: "yuv420p",
          color_transfer: options.badSource && !output ? "smpte2084" : "bt709",
          color_primaries: "bt709",
          color_space: "bt709",
          color_range: "tv",
          sample_aspect_ratio: "1:1",
          disposition: { attached_pic: 0 },
        },
      ],
    };
  }

  const worker = {
    loaded: true,
    terminations: 0,

    async createDir(path) {
      directories.add(path);
      return true;
    },

    async listDir(path) {
      if (!directories.has(path)) throw new Error("Missing directory.");

      return Array.from(files.keys())
        .filter((name) => name.startsWith(`${path}/`))
        .map((name) => ({
          name: name.slice(path.length + 1),
          isDir: false,
        }));
    },

    async writeFile(path, bytes) {
      calls.push("write");
      files.set(
        path,
        structuredClone(bytes, {
          transfer: [bytes.buffer],
        }),
      );
      return true;
    },

    async ffprobe(args) {
      const input = args[args.indexOf("-o") - 1];
      const output = args[args.indexOf("-o") + 1];
      const encodedOutput = input.endsWith("/output.mp4");

      calls.push(encodedOutput ? "probe-output" : "probe-input");
      files.set(output, JSON.stringify(report(encodedOutput)));
      return -1;
    },

    async readFile(path) {
      if (!files.has(path)) throw new Error("Missing file.");
      return files.get(path);
    },

    async deleteFile(path) {
      if (options.failCleanup && path.endsWith("/input.bin")) {
        throw new Error("Cleanup failed.");
      }

      files.delete(path);
      return true;
    },

    async deleteDir(path) {
      directories.delete(path);
      calls.push("cleanup");
      return true;
    },

    terminate() {
      this.terminations += 1;
      this.loaded = false;
      files.clear();
      directories.clear();
    },
  };

  const context = {
    jobId: "browser-mp4-bytes-test",
    signal: new AbortController().signal,
    reportProgress() {},
    beginCommit() {
      throw new Error("Preparation must not request publication.");
    },
  };

  const input = new Uint8Array([1, 2, 3]);

  const plan = {
    input: { kind: "bytes", bytes: input },
    transformations: [],
    terminal: {
      type: "export",
      format: "mp4",
      preset: "video-balanced-v1",
    },
    output: { kind: "bytes" },
  };

  const inventory = {
    encoders: ["libx264"],
    decoders: ["h264"],
    muxers: ["mp4"],
    demuxers: ["mov", "mp4"],
    filters: [],
  };

  const dependencies = {
    async analyze(_worker, analysis) {
      calls.push("analyze");

      const directory = analysis.inputPath.slice(0, analysis.inputPath.lastIndexOf("/"));

      assert.equal(
        files.has(`${directory}/output.mp4`),
        false,
        "Selection analysis must precede output creation.",
      );

      if (options.emptyTrim) {
        throw createMavioError("INVALID_OPTIONS", "The requested trim contains no video frames.", {
          stage: "preparing",
          details: {
            reason: "RANGE_TOO_SHORT",
            streamKind: "video",
          },
        });
      }

      return { videoFrames: 3 };
    },
    async execute(_worker, command) {
      calls.push("encode");
      files.set(command.outputPath, encoded);
    },
  };

  return {
    worker,
    context,
    plan,
    inventory,
    dependencies,
    input,
    encoded,
    files,
    directories,
    calls,
  };
}

function prepare(value) {
  return prepareBrowserMp4Bytes(
    value.worker,
    value.plan,
    value.inventory,
    value.context,
    value.dependencies,
  );
}

test("MP4 byte preparation cleans staging and returns independent bytes", async () => {
  const value = fixture();
  const result = await prepare(value);

  assert.equal(result.metadata.container, "mov,mp4,m4a,3gp,3g2,mj2");
  assert.equal(result.bytes.length, 64);
  assert.deepEqual(Array.from(value.input), [1, 2, 3]);

  assert.deepEqual(value.calls, ["write", "probe-input", "encode", "probe-output", "cleanup"]);

  assert.equal(value.files.size, 0);
  assert.equal(value.directories.size, 0);
  assert.equal(value.worker.terminations, 0);

  const snapshot = result.bytes.slice();
  value.encoded.fill(0);
  value.worker.terminate();

  assert.deepEqual(result.bytes, snapshot);
});

test("MP4 preparation accepts Blob input without modifying it", async () => {
  const value = fixture();
  const blob = new Blob([value.input]);
  value.plan.input = { kind: "blob", blob };

  await prepare(value);

  assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [1, 2, 3]);
});

test("unsupported source profiles reject before encoding and discard staging", async () => {
  const value = fixture({ badSource: true });

  await assert.rejects(prepare(value), {
    code: "UNSUPPORTED_CAPABILITY",
  });

  assert.equal(value.calls.includes("encode"), false);
  assert.equal(value.worker.terminations, 1);
  assert.equal(value.directories.size, 0);
});

test("incorrect output dimensions reject instead of returning bytes", async () => {
  const value = fixture({ outputWidth: 640 });

  await assert.rejects(prepare(value), {
    code: "EXECUTION_FAILED",
    details: {
      reason: "OUTPUT_DIMENSIONS_MISMATCH",
      preset: "video-balanced-v1",
    },
  });

  assert.equal(value.worker.terminations, 1);
});

test("output byte-size mismatch rejects and discards the worker", async () => {
  const value = fixture({ outputSize: 65 });

  await assert.rejects(prepare(value), {
    code: "EXECUTION_FAILED",
    details: {
      reason: "OUTPUT_BYTE_SIZE_MISMATCH",
      preset: "video-balanced-v1",
    },
  });

  assert.equal(value.worker.terminations, 1);
});

test("cleanup failure prevents a prepared result from being returned", async () => {
  const value = fixture({ failCleanup: true });

  await assert.rejects(prepare(value), {
    code: "CLEANUP_FAILED",
  });

  assert.equal(value.worker.terminations, 1);
  assert.equal(value.files.size, 0);
});

test("pre-aborted preparation does not touch the worker", async () => {
  const value = fixture();
  const controller = new AbortController();
  controller.abort();
  value.context.signal = controller.signal;

  await assert.rejects(prepare(value), { code: "CANCELLED" });

  assert.deepEqual(value.calls, []);
  assert.equal(value.worker.terminations, 0);
});

test("trim preparation analyzes selection before encoding and cleans staging", async () => {
  const value = fixture();

  value.inventory.filters = ["trim", "settb", "setpts"];
  value.plan.transformations = [{ type: "trim", options: { start: 0.125, end: 0.375 } }];

  const result = await prepare(value);

  assert.equal(result.bytes.length, 64);

  assert.deepEqual(value.calls, [
    "write",
    "probe-input",
    "analyze",
    "encode",
    "probe-output",
    "cleanup",
  ]);

  assert.equal(value.directories.size, 0);
  assert.equal(value.worker.terminations, 0);
});

test("empty trim selection prevents encoding and discards its staging", async () => {
  const value = fixture({ emptyTrim: true });

  value.inventory.filters = ["trim", "settb", "setpts"];
  value.plan.transformations = [{ type: "trim", options: { start: 0.125, end: 0.375 } }];

  await assert.rejects(prepare(value), {
    code: "INVALID_OPTIONS",
    details: {
      reason: "RANGE_TOO_SHORT",
      streamKind: "video",
    },
  });

  assert.deepEqual(value.calls, ["write", "probe-input", "analyze"]);

  assert.equal(value.worker.terminations, 1);
  assert.equal(value.directories.size, 0);
});

test("resized MP4 preparation validates planned dimensions and cleans staging", async () => {
  const value = fixture({
    outputWidth: 160,
    outputHeight: 90,
  });

  value.inventory.filters = ["scale", "setsar"];

  value.plan.transformations = [
    {
      type: "resize",
      options: { width: 160, height: 90 },
    },
    {
      type: "resize",
      options: { width: 640, height: 360 },
    },
  ];

  const result = await prepare(value);
  const video = result.metadata.streams.find((stream) => stream.kind === "video");

  assert.equal(video.width, 160);
  assert.equal(video.height, 90);
  assert.equal(result.bytes.length, 64);

  assert.deepEqual(Array.from(value.input), [1, 2, 3]);
  assert.equal(value.files.size, 0);
  assert.equal(value.directories.size, 0);
  assert.equal(value.worker.terminations, 0);
});

test("resize preparation rejects output that retains the original dimensions", async () => {
  const value = fixture();

  value.inventory.filters = ["scale", "setsar"];

  value.plan.transformations = [
    {
      type: "resize",
      options: { width: 160, height: 90 },
    },
  ];

  await assert.rejects(prepare(value), {
    code: "EXECUTION_FAILED",
    details: {
      reason: "OUTPUT_DIMENSIONS_MISMATCH",
      preset: "video-balanced-v1",
    },
  });

  assert.equal(value.worker.terminations, 1);
  assert.equal(value.files.size, 0);
  assert.equal(value.directories.size, 0);
});

test("invalid resize rejects before trim analysis or encoding", async () => {
  const value = fixture();

  value.inventory.filters = ["trim", "settb", "setpts", "scale", "setsar"];

  value.plan.transformations = [
    {
      type: "trim",
      options: { start: 0.125, end: 0.375 },
    },
    {
      type: "resize",
      options: { width: 1, height: 1 },
    },
  ];

  await assert.rejects(prepare(value), (error) => {
    assert.equal(error.code, "INVALID_OPTIONS");
    assert.equal(error.details.reason, "INVALID_DIMENSIONS");
    assert.equal(error.details.operationIndex, 1);
    return true;
  });

  assert.equal(value.calls.includes("analyze"), false);
  assert.equal(value.calls.includes("encode"), false);
  assert.equal(value.worker.terminations, 1);
  assert.equal(value.directories.size, 0);
});

test("missing resize filters reject before output creation", async () => {
  const value = fixture();

  value.inventory.filters = ["scale"];

  value.plan.transformations = [
    {
      type: "resize",
      options: { width: 160, height: 90 },
    },
  ];

  await assert.rejects(prepare(value), {
    code: "UNSUPPORTED_CAPABILITY",
    details: {
      reason: "MISSING_FILTER",
      filter: "setsar",
    },
  });

  assert.equal(value.calls.includes("encode"), false);
  assert.equal(value.files.size, 0);
  assert.equal(value.directories.size, 0);
});
