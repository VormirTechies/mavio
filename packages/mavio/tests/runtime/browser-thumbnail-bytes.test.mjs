import assert from "node:assert/strict";
import test from "node:test";
import { prepareBrowserThumbnailBytes } from "../../dist/engines/browser/thumbnail-bytes.js";

function fixture(settings = {}) {
  const preset = settings.preset ?? "jpeg-balanced-v1";
  const jpeg = preset === "jpeg-balanced-v1";
  const format = jpeg ? "jpeg" : "png";
  const width = settings.width ?? 320;
  const height = settings.height ?? 180;

  const encoded = jpeg ? new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217]) : new Uint8Array(58);

  if (!jpeg) {
    const view = new DataView(encoded.buffer);
    const text = (offset, value) => {
      encoded.set(new TextEncoder().encode(value), offset);
    };

    encoded.set([137, 80, 78, 71, 13, 10, 26, 10]);
    view.setUint32(8, 13, false);
    text(12, "IHDR");
    view.setUint32(16, width, false);
    view.setUint32(20, height, false);
    encoded[24] = 8;
    encoded[25] = 2;
    view.setUint32(33, 1, false);
    text(37, "IDAT");
    encoded[41] = 1;
    text(50, "IEND");
  }

  const files = new Map();
  const directories = new Set();
  const calls = [];
  const controller = new AbortController();
  const input = new Uint8Array([1, 2, 3]);

  function report(output) {
    return {
      format: {
        format_name: output ? `${format}_pipe` : "mov,mp4",
        size: String(output ? encoded.length : input.length),
        start_time: "0",
        ...(output ? {} : { duration: "1" }),
      },
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: output ? (jpeg ? "mjpeg" : "png") : "h264",
          width: output ? width : 320,
          height: output ? height : 180,
          pix_fmt: output ? (jpeg ? "yuvj420p" : "rgb24") : "yuv420p",
          color_transfer: "bt709",
          color_primaries: "bt709",
          color_space: "bt709",
          color_range: output ? "pc" : "tv",
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
      assert.equal(directories.has(path), true);

      return [...files.keys()]
        .filter((name) => name.startsWith(`${path}/`))
        .map((name) => ({
          name: name.slice(path.length + 1),
          isDir: false,
        }));
    },

    async writeFile(path, bytes) {
      calls.push("write");
      files.set(path, structuredClone(bytes, { transfer: [bytes.buffer] }));
      return true;
    },

    async ffprobe(args) {
      const index = args.indexOf("-o");
      const output = args[index - 1].endsWith(`/output.${format}`);

      calls.push(output ? "probe-output" : "probe-input");

      files.set(
        args[index + 1],
        settings.invalidProbe && output ? "{invalid" : JSON.stringify(report(output)),
      );

      return -1;
    },

    async readFile(path) {
      if (!files.has(path)) throw new Error("Missing file.");
      return files.get(path);
    },

    async deleteFile(path) {
      if (settings.failCleanup && path.endsWith("/input.bin")) {
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
      this.loaded = false;
      this.terminations += 1;
      files.clear();
      directories.clear();
    },
  };

  const plan = {
    input: { kind: "bytes", bytes: input },
    transformations: [],
    terminal: {
      type: "thumbnail",
      at: 0.125,
      format,
      preset,
    },
    output: { kind: "bytes" },
  };

  const context = {
    jobId: "browser-thumbnail-bytes-test",
    signal: controller.signal,
    reportProgress() {},
    beginCommit() {
      throw new Error("Preparation must not publish.");
    },
  };

  const inventory = {
    encoders: ["mjpeg", "png", "rawvideo"],
    decoders: ["h264"],
    muxers: ["image2pipe", "framemd5"],
    demuxers: ["mov"],
    filters: ["trim", "setpts", "scale", "format", "setsar"],
  };

  const dependencies = {
    async analyze(_worker, options) {
      calls.push("analyze");

      assert.equal(
        [...files.keys()].some((path) => path.includes("/output.")),
        false,
      );

      assert.equal(options.selection.source.videoStreamIndex, 0);

      if (settings.analysisFailure) throw settings.analysisFailure;
      if (settings.cancelAnalysis) controller.abort();

      return { videoFrames: settings.frames ?? 1 };
    },

    async execute(_worker, options) {
      calls.push("encode");

      if (settings.executionFailure) throw settings.executionFailure;
      if (settings.badSignature) encoded[0] = 0;

      files.set(options.outputPath, encoded);
    },
  };

  return {
    worker,
    plan,
    context,
    inventory,
    dependencies,
    controller,
    calls,
    files,
    directories,
    input,
    encoded,
  };
}

function prepare(value) {
  return prepareBrowserThumbnailBytes(
    value.worker,
    value.plan,
    value.inventory,
    value.context,
    value.dependencies,
  );
}

test("thumbnail preparation analyzes before encoding and returns owned bytes after cleanup", async () => {
  for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
    const value = fixture({ preset });
    const result = await prepare(value);

    assert.deepEqual(value.calls, [
      "write",
      "probe-input",
      "analyze",
      "encode",
      "probe-output",
      "cleanup",
    ]);

    assert.equal(value.files.size, 0);
    assert.equal(value.directories.size, 0);
    assert.equal(value.worker.terminations, 0);

    const snapshot = result.bytes.slice();
    value.encoded.fill(0);
    value.worker.terminate();

    assert.deepEqual(result.bytes, snapshot);
    assert.deepEqual(value.input, new Uint8Array([1, 2, 3]));
  }
});

test("thumbnail preparation supports Blob input and validates planned resize dimensions", async () => {
  const value = fixture({
    preset: "png-lossless-v1",
    width: 160,
    height: 90,
  });

  const blob = new Blob([value.input]);
  value.plan.input = { kind: "blob", blob };
  value.plan.transformations = [{ type: "resize", options: { width: 160, height: 90 } }];

  const result = await prepare(value);

  assert.equal(result.metadata.streams[0].width, 160);
  assert.equal(result.metadata.streams[0].height, 90);

  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

test("empty or invalid frame evidence rejects before image encoding", async () => {
  for (const frames of [0, 2, NaN]) {
    const value = fixture({ frames });

    await assert.rejects(prepare(value), {
      code: frames === 0 ? "INVALID_OPTIONS" : "EXECUTION_FAILED",
    });

    assert.equal(value.calls.includes("encode"), false);
    assert.equal(value.worker.terminations, 1);
    assert.equal(value.files.size, 0);
  }
});

test("thumbnail preparation preserves analysis failure causes", async () => {
  const failure = new Error("Analysis trapped.");
  const value = fixture({ analysisFailure: failure });

  await assert.rejects(prepare(value), (error) => {
    assert.equal(error.code, "EXECUTION_FAILED");
    assert.equal(error.cause, failure);
    return true;
  });

  assert.equal(value.calls.includes("encode"), false);
  assert.equal(value.files.size, 0);
});

test("thumbnail preparation handles cancellation before admission and after analysis", async () => {
  const before = fixture();
  before.controller.abort();

  await assert.rejects(prepare(before), { code: "CANCELLED" });
  assert.deepEqual(before.calls, []);
  assert.equal(before.worker.terminations, 0);

  const active = fixture({ cancelAnalysis: true });

  await assert.rejects(prepare(active), { code: "CANCELLED" });
  assert.equal(active.calls.includes("encode"), false);
  assert.equal(active.worker.terminations, 1);
});

test("thumbnail preparation preserves encoding failure causes", async () => {
  const failure = new Error("Encoder trapped.");
  const value = fixture({ executionFailure: failure });

  await assert.rejects(prepare(value), (error) => {
    assert.equal(error.code, "EXECUTION_FAILED");
    assert.equal(error.stage, "running");
    assert.equal(error.cause, failure);
    return true;
  });

  assert.equal(value.files.size, 0);
});

test("thumbnail preparation rejects invalid probe output, signatures and dimensions", async () => {
  for (const settings of [{ invalidProbe: true }, { badSignature: true }, { width: 160 }]) {
    const value = fixture(settings);

    await assert.rejects(prepare(value), {
      code: "EXECUTION_FAILED",
      stage: "finalizing",
    });

    assert.equal(value.worker.terminations, 1);
    assert.equal(value.files.size, 0);
  }
});

test("thumbnail cleanup failure rejects instead of returning output", async () => {
  const value = fixture({ failCleanup: true });

  await assert.rejects(prepare(value), {
    code: "CLEANUP_FAILED",
    stage: "finalizing",
  });

  assert.equal(value.worker.terminations, 1);
  assert.equal(value.files.size, 0);
  assert.equal(value.directories.size, 0);
});
