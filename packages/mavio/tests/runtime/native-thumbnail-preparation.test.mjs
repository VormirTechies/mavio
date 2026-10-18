import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { prepareNativeThumbnailFile } from "../../dist/engines/native/thumbnail-file.js";
import { prepareNativeThumbnailBytes } from "../../dist/engines/native/thumbnail-bytes.js";
import { NativeProcessError } from "../../dist/engines/native/process.js";

function report(count = 1) {
  return [
    "#format: frame checksums",
    "#version: 2",
    "#hash: MD5",
    "#media_type 0: video",
    "#codec_id 0: rawvideo",
    ...Array.from(
      { length: count },
      (_, index) => `0, ${index}, ${index}, 1, 86400, 0123456789abcdef0123456789abcdef`,
    ),
  ].join("\n");
}

function fixture(preset = "png-lossless-v1") {
  const jpeg = preset === "jpeg-balanced-v1";
  const controller = new AbortController();
  const inputPath = resolve("thumbnail source.bin");
  const outputPath = resolve("thumbnail staging.bin");
  const events = [];
  const cancellation = new Error("Requested cancellation.");

  const f = {
    events,
    controller,
    cancellation,
    inputPath,
    outputPath,
    cancelAt: undefined,
    analysisText: report(),
    analysisDiagnostic: "",
    analysisError: undefined,
    encodingError: undefined,
    outputBytes: new Uint8Array([10, 20, 30]),
  };

  function hit(name) {
    events.push(name);
    if (f.cancelAt === name) controller.abort(cancellation);
  }

  f.source = {
    formatStartTimeSeconds: 0,
    metadata: {
      durationSeconds: 2,
      streams: [{ index: 0, kind: "video", codec: "h264", width: 320, height: 180 }],
    },
    streams: [
      {
        index: 0,
        attachedPicture: false,
        defaultOrientation: true,
        sampleAspectRatio: "1:1",
        pixelFormat: "yuv420p",
        colorTransfer: "bt709",
        colorPrimaries: "bt709",
        colorSpace: "bt709",
        colorRange: "tv",
      },
    ],
  };

  f.encoded = {
    metadata: {
      sizeBytes: 3,
      streams: [
        {
          index: 0,
          kind: "video",
          codec: jpeg ? "mjpeg" : "png",
          width: 320,
          height: 180,
        },
      ],
    },
    streams: [
      {
        index: 0,
        pixelFormat: jpeg ? "yuvj420p" : "rgb24",
        defaultOrientation: true,
        sampleAspectRatio: "1:1",
      },
    ],
  };

  f.options = {
    configuration: { cwd: resolve(".") },
    tools: {
      ffmpeg: { path: resolve("ffmpeg"), version: "test" },
      ffprobe: { path: resolve("ffprobe"), version: "test" },
    },
    inventory: {
      encoders: ["rawvideo", "mjpeg", "png"],
      decoders: [],
      muxers: ["framemd5", "image2pipe"],
      demuxers: [],
      filters: ["trim", "setpts", "scale", "format", "setsar"],
    },
    plan: {
      input: { kind: "bytes", bytes: new Uint8Array([1, 2, 3]) },
      transformations: [],
      terminal: {
        type: "thumbnail",
        at: 0.51,
        preset,
        format: jpeg ? "jpeg" : "png",
      },
      output: { kind: "bytes" },
    },
    context: {
      jobId: "thumbnail-preparation-test",
      signal: controller.signal,
    },
    workspace: {
      async writeInput() {
        hit("stage");
        return inputPath;
      },
      getOutputPath() {
        return outputPath;
      },
      async readOutput() {
        hit("read");
        return f.outputBytes;
      },
      async dispose() {
        assert.fail("Preparation must leave workspace cleanup to its caller.");
      },
    },
  };

  f.dependencies = {
    async probe(_configuration, _tools, path) {
      if (path === inputPath) {
        hit("probe-input");
        return f.source;
      }

      assert.equal(path, outputPath);
      hit("probe-output");
      return f.encoded;
    },
    async run(options) {
      hit("analyze");
      assert.equal(options.signal, controller.signal);
      assert.equal(options.args[options.args.indexOf("-frames:v") + 1], "1");

      if (f.analysisError !== undefined) throw f.analysisError;

      return {
        stdout: f.analysisText,
        stderr: f.analysisDiagnostic,
      };
    },
    async execute(_configuration, _tools, options) {
      hit("encode");
      assert.equal(options.inputPath, inputPath);
      assert.equal(options.outputPath, outputPath);

      if (f.encodingError !== undefined) throw f.encodingError;
    },
  };

  return f;
}

test("thumbnail file preparation validates staging without reading or disposing it", async () => {
  for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
    const f = fixture(preset);
    const snapshot = f.options.plan.input.bytes.slice();

    const result = await prepareNativeThumbnailFile(f.options, f.dependencies);

    assert.equal(result.path, f.outputPath);
    assert.deepEqual(result.metadata, f.encoded.metadata);
    assert.deepEqual(f.options.plan.input.bytes, snapshot);
    assert.deepEqual(f.events, ["stage", "probe-input", "analyze", "encode", "probe-output"]);
  }
});

test("thumbnail path preparation skips staging and preserves the final target", async () => {
  const f = fixture();
  const target = resolve("public thumbnail.png");

  f.options.plan.input = { kind: "path", path: f.inputPath };
  f.options.plan.output = { kind: "path", path: target };

  const result = await prepareNativeThumbnailFile(f.options, f.dependencies);

  assert.equal(result.path, f.outputPath);
  assert.notEqual(result.path, target);
  assert.deepEqual(f.events, ["probe-input", "analyze", "encode", "probe-output"]);
});

test("empty, malformed and multi-frame analysis never reach encoding", async () => {
  for (const [text, code, reason] of [
    [report(0), "INVALID_OPTIONS", "RANGE_TOO_SHORT"],
    ["invalid report", "EXECUTION_FAILED", "INVALID_TRIM_SELECTION"],
    [report(2), "EXECUTION_FAILED", "INVALID_THUMBNAIL_SELECTION"],
  ]) {
    const f = fixture();
    f.analysisText = text;

    await assert.rejects(prepareNativeThumbnailFile(f.options, f.dependencies), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.details.reason, reason);
      return true;
    });

    assert.deepEqual(f.events, ["stage", "probe-input", "analyze"]);
  }
});

test("analysis diagnostics and process failures prevent encoding", async () => {
  for (const mode of ["diagnostic", "limit", "process"]) {
    const f = fixture();

    if (mode === "diagnostic") {
      f.analysisDiagnostic = "Decoder reported an error.";
    } else {
      f.analysisError = new NativeProcessError(mode === "limit" ? "OUTPUT_LIMIT" : "NONZERO_EXIT");
    }

    await assert.rejects(prepareNativeThumbnailFile(f.options, f.dependencies), (error) => {
      assert.equal(error.code, mode === "limit" ? "RESOURCE_LIMIT" : "EXECUTION_FAILED");

      if (mode !== "diagnostic") {
        assert.equal(error.cause, f.analysisError);
      }

      return true;
    });

    assert.deepEqual(f.events, ["stage", "probe-input", "analyze"]);
  }
});

test("thumbnail cancellation stops work at every asynchronous boundary", async () => {
  const order = ["stage", "probe-input", "analyze", "encode", "probe-output", "read"];

  for (const boundary of ["before", ...order]) {
    const f = fixture();
    f.cancelAt = boundary;

    if (boundary === "before") {
      f.controller.abort(f.cancellation);
    }

    await assert.rejects(prepareNativeThumbnailBytes(f.options, f.dependencies), (error) => {
      assert.equal(error.code, "CANCELLED");
      assert.equal(error.cause, f.cancellation);
      return true;
    });

    assert.deepEqual(
      f.events,
      boundary === "before" ? [] : order.slice(0, order.indexOf(boundary) + 1),
    );
  }
});

test("thumbnail encoding failures preserve the original error", async () => {
  const f = fixture();
  f.encodingError = new Error("Original encoder failure.");

  await assert.rejects(prepareNativeThumbnailFile(f.options, f.dependencies), (error) => {
    assert.equal(error, f.encodingError);
    return true;
  });

  assert.deepEqual(f.events, ["stage", "probe-input", "analyze", "encode"]);
});

test("thumbnail preparation validates the planned resized dimensions", async () => {
  for (const [preset, width, height] of [
    ["jpeg-balanced-v1", 158, 88],
    ["png-lossless-v1", 159, 89],
  ]) {
    const f = fixture(preset);

    f.options.plan.transformations = [{ type: "resize", options: { width: 159, height: 99 } }];

    await assert.rejects(prepareNativeThumbnailFile(f.options, f.dependencies), (error) => {
      assert.equal(error.code, "EXECUTION_FAILED");
      assert.equal(error.details.reason, "OUTPUT_DIMENSIONS_MISMATCH");
      return true;
    });

    // Use a separate fixture for the successful operation.
    const valid = fixture(preset);
    valid.options.plan.transformations = [{ type: "resize", options: { width: 159, height: 99 } }];
    valid.encoded.metadata.streams[0].width = width;
    valid.encoded.metadata.streams[0].height = height;

    const result = await prepareNativeThumbnailFile(valid.options, valid.dependencies);
    assert.equal(result.metadata.streams[0].width, width);
    assert.equal(result.metadata.streams[0].height, height);
  }
});

test("thumbnail byte preparation rejects output-size changes", async () => {
  const f = fixture();
  f.outputBytes = new Uint8Array([10, 20]);

  await assert.rejects(prepareNativeThumbnailBytes(f.options, f.dependencies), (error) => {
    assert.equal(error.code, "EXECUTION_FAILED");
    assert.equal(error.details.reason, "OUTPUT_SIZE_CHANGED");
    return true;
  });

  assert.equal(f.events.at(-1), "read");
});

test("returned thumbnail bytes do not share workspace storage", async () => {
  const f = fixture();
  const result = await prepareNativeThumbnailBytes(f.options, f.dependencies);

  f.outputBytes.fill(0);

  assert.deepEqual(result.bytes, new Uint8Array([10, 20, 30]));
  assert.notEqual(result.bytes.buffer, f.outputBytes.buffer);
});

test("missing analysis support rejects before staging", async () => {
  const f = fixture();
  f.options.inventory.encoders = ["mjpeg", "png"];

  await assert.rejects(prepareNativeThumbnailFile(f.options, f.dependencies), (error) => {
    assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
    assert.equal(error.details.reason, "MISSING_THUMBNAIL_ANALYSIS_FEATURE");
    return true;
  });

  assert.deepEqual(f.events, []);
});
