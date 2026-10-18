import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { prepareNativeMp4Bytes } from "../../dist/engines/native/mp4-bytes.js";
import { prepareNativeMp4File } from "../../dist/engines/native/mp4-file.js";
import { createMavioError } from "../../dist/core/errors.js";

function setup(byteInput = false) {
  const events = [];
  const controller = new AbortController();
  const inputPath = resolve("input.mp4");
  const outputPath = resolve("output.mp4");

  const source = {
    metadata: {
      container: "mov,mp4,m4a,3gp,3g2,mj2",
      durationSeconds: 2,
      sizeBytes: 3,
      streams: [
        {
          index: 0,
          kind: "video",
          codec: "h264",
          width: 320,
          height: 180,
        },
      ],
    },
    streams: [
      {
        index: 0,
        attachedPicture: false,
        pixelFormat: "yuv420p",
        colorTransfer: "bt709",
        colorPrimaries: "bt709",
        colorSpace: "bt709",
        colorRange: "tv",
      },
    ],
  };

  const encoded = structuredClone(source);

  const options = {
    configuration: { cwd: resolve(".") },
    tools: {
      ffmpeg: { path: resolve("ffmpeg"), version: "test" },
      ffprobe: { path: resolve("ffprobe"), version: "test" },
    },
    inventory: {
      encoders: ["libx264"],
      decoders: [],
      muxers: ["mp4"],
      demuxers: [],
      filters: [],
    },
    plan: {
      input: byteInput
        ? { kind: "bytes", bytes: new Uint8Array([8, 9]) }
        : { kind: "path", path: inputPath },
      transformations: [],
      terminal: {
        type: "export",
        format: "mp4",
        preset: "video-balanced-v1",
      },
      output: { kind: "bytes" },
    },
    context: {
      jobId: "mp4-bytes-test",
      signal: controller.signal,
    },
    workspace: {
      async writeInput(bytes) {
        events.push("stage");
        assert.deepEqual([...bytes], [8, 9]);
        return inputPath;
      },
      getOutputPath() {
        return outputPath;
      },
      async readOutput() {
        events.push("read");
        return new Uint8Array([1, 2, 3]);
      },
      async dispose() {
        events.push("dispose");
      },
    },
  };

  const dependencies = {
    async probe(_configuration, _tools, path) {
      if (path === inputPath) {
        events.push("probe-input");
        return source;
      }

      assert.equal(path, outputPath);
      events.push("probe-output");
      return encoded;
    },
    async execute(_configuration, _tools, command) {
      events.push("encode");
      assert.equal(command.inputPath, inputPath);
      assert.equal(command.outputPath, outputPath);
    },
  };

  return { options, dependencies, source, encoded, events, controller };
}

test("byte preparation stages only byte inputs and preserves caller cleanup ownership", async () => {
  for (const byteInput of [false, true]) {
    const state = setup(byteInput);
    const result = await prepareNativeMp4Bytes(state.options, state.dependencies);

    assert.deepEqual([...result.bytes], [1, 2, 3]);
    assert.deepEqual(result.metadata, state.encoded.metadata);
    assert.deepEqual(state.events, [
      ...(byteInput ? ["stage"] : []),
      "probe-input",
      "encode",
      "probe-output",
      "read",
    ]);
  }
});

test("unsupported source properties stop byte preparation before encoding", async () => {
  const state = setup();
  state.source.streams[0].pixelFormat = "yuv420p10le";

  await assert.rejects(prepareNativeMp4Bytes(state.options, state.dependencies), {
    code: "UNSUPPORTED_CAPABILITY",
  });

  assert.deepEqual(state.events, ["probe-input"]);
});

test("invalid encoded metadata stops byte preparation before reading", async () => {
  const state = setup();
  state.encoded.metadata.streams[0].width = 160;

  await assert.rejects(prepareNativeMp4Bytes(state.options, state.dependencies), {
    code: "EXECUTION_FAILED",
    details: {
      reason: "OUTPUT_DIMENSIONS_MISMATCH",
      preset: "video-balanced-v1",
    },
  });

  assert.deepEqual(state.events, ["probe-input", "encode", "probe-output"]);
});

test("cancellation after encoding prevents output probing and reading", async () => {
  const state = setup();
  state.dependencies.execute = async () => {
    state.events.push("encode");
    state.controller.abort("stopped");
  };

  await assert.rejects(prepareNativeMp4Bytes(state.options, state.dependencies), {
    code: "CANCELLED",
    cause: "stopped",
  });

  assert.deepEqual(state.events, ["probe-input", "encode"]);
});

test("byte preparation rejects a size change after output probing", async () => {
  const state = setup();
  state.encoded.metadata.sizeBytes = 4;

  await assert.rejects(prepareNativeMp4Bytes(state.options, state.dependencies), {
    code: "EXECUTION_FAILED",
    details: { reason: "OUTPUT_SIZE_CHANGED" },
  });

  assert.deepEqual(state.events, ["probe-input", "encode", "probe-output", "read"]);
});

test("file preparation returns validated staging without reading or publishing it", async () => {
  for (const byteInput of [false, true]) {
    const state = setup(byteInput);
    const target = resolve("published.mp4");
    state.options.plan.output = { kind: "path", path: target };

    const result = await prepareNativeMp4File(state.options, state.dependencies);

    assert.equal(result.path, state.options.workspace.getOutputPath());
    assert.notEqual(result.path, target);
    assert.deepEqual(result.metadata, state.encoded.metadata);
    assert.deepEqual(state.events, [
      ...(byteInput ? ["stage"] : []),
      "probe-input",
      "encode",
      "probe-output",
    ]);
  }
});

test("file preparation rejects invalid encoded output before returning a staging result", async () => {
  const state = setup();
  state.options.plan.output = {
    kind: "path",
    path: resolve("published.mp4"),
  };
  state.encoded.metadata.streams[0].codec = "hevc";

  await assert.rejects(prepareNativeMp4File(state.options, state.dependencies), {
    code: "EXECUTION_FAILED",
    details: {
      reason: "OUTPUT_VIDEO_CODEC_MISMATCH",
      preset: "video-balanced-v1",
    },
  });

  assert.deepEqual(state.events, ["probe-input", "encode", "probe-output"]);
});

test("byte wrapper rejects path output before staging or encoding", async () => {
  const state = setup(true);
  state.options.plan.output = {
    kind: "path",
    path: resolve("published.mp4"),
  };

  await assert.rejects(prepareNativeMp4Bytes(state.options, state.dependencies), {
    code: "UNSUPPORTED_CAPABILITY",
  });

  assert.deepEqual(state.events, []);
});

function enableTrim(state) {
  state.source.formatStartTimeSeconds = 0;
  state.options.inventory.filters = ["trim", "settb", "setpts", "atrim", "asetpts"];
  state.options.plan.transformations = [{ type: "trim", options: { start: 0.51, end: 1.49 } }];

  state.dependencies.analyzeTrim = async (request) => {
    state.events.push("analyze");

    assert.equal(request.inputPath, resolve("input.mp4"));
    assert.equal(request.videoStreamIndex, 0);
    assert.equal(request.context, state.options.context);
    assert.equal(
      request.filters.video,
      "trim=start=510000us:end=1490000us,settb=expr=1/1000000,setpts=PTS-510000/(1000000*TB)",
    );

    return { videoFrames: 23 };
  };
}

test("trim preparation analyzes staged or path input before encoding", async () => {
  for (const byteInput of [false, true]) {
    const state = setup(byteInput);
    enableTrim(state);

    const result = await prepareNativeMp4Bytes(state.options, state.dependencies);

    assert.deepEqual([...result.bytes], [1, 2, 3]);
    assert.deepEqual(state.events, [
      ...(byteInput ? ["stage"] : []),
      "probe-input",
      "analyze",
      "encode",
      "probe-output",
      "read",
    ]);
  }
});

test("untrimmed preparation does not run trim analysis", async () => {
  const state = setup();

  state.dependencies.analyzeTrim = async () => {
    assert.fail("Untrimmed exports must not run trim analysis");
  };

  await prepareNativeMp4File(state.options, state.dependencies);

  assert.deepEqual(state.events, ["probe-input", "encode", "probe-output"]);
});

test("trim analysis failures prevent encoding and retain caller cleanup ownership", async () => {
  const state = setup(true);
  enableTrim(state);

  const failure = createMavioError(
    "RESOURCE_LIMIT",
    "Selection analysis exceeded its output limit.",
    {
      stage: "preparing",
      operation: "trim",
      details: { reason: "OUTPUT_LIMIT" },
    },
  );

  state.dependencies.analyzeTrim = async () => {
    state.events.push("analyze");
    throw failure;
  };

  await assert.rejects(
    prepareNativeMp4Bytes(state.options, state.dependencies),
    (error) => error === failure,
  );

  assert.deepEqual(state.events, ["stage", "probe-input", "analyze"]);
});

test("cancellation after trim analysis prevents encoding", async () => {
  const state = setup();
  enableTrim(state);

  state.dependencies.analyzeTrim = async () => {
    state.events.push("analyze");
    state.controller.abort("stop before encoding");
    return { videoFrames: 23 };
  };

  await assert.rejects(prepareNativeMp4File(state.options, state.dependencies), {
    code: "CANCELLED",
    cause: "stop before encoding",
  });

  assert.deepEqual(state.events, ["probe-input", "analyze"]);
});

test("empty or malformed analysis results cannot reach the encoder", async () => {
  for (const [selection, code, reason] of [
    [{ videoFrames: 0 }, "INVALID_OPTIONS", "RANGE_TOO_SHORT"],
    [{ videoFrames: NaN }, "EXECUTION_FAILED", "INVALID_TRIM_SELECTION"],
  ]) {
    const state = setup();
    enableTrim(state);

    state.dependencies.analyzeTrim = async () => {
      state.events.push("analyze");
      return selection;
    };

    await assert.rejects(prepareNativeMp4File(state.options, state.dependencies), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.details.reason, reason);
      return true;
    });

    assert.deepEqual(state.events, ["probe-input", "analyze"]);
  }
});

test("trim preparation forwards selected audio metadata and requires audio samples", async () => {
  for (const audioSamples of [47040, 0]) {
    const state = setup();
    enableTrim(state);

    state.options.inventory.encoders.push("aac");

    const audioMetadata = {
      index: 7,
      kind: "audio",
      codec: "aac",
      sampleRate: 48000,
      channels: 2,
    };
    const audioDetails = {
      index: 7,
      channelLayout: "stereo",
    };

    state.source.metadata.streams.push(audioMetadata);
    state.source.streams.push(audioDetails);
    state.encoded.metadata.streams.push({ ...audioMetadata });
    state.encoded.streams.push({ ...audioDetails });

    state.dependencies.analyzeTrim = async (request) => {
      state.events.push("analyze");
      assert.deepEqual(request.audio, {
        streamIndex: 7,
        channels: 2,
      });
      assert.equal(
        request.filters.audio,
        "atrim=start=510000us:end=1490000us,asetpts=PTS-510000/(1000000*TB)",
      );

      return { videoFrames: 23, audioSamples };
    };

    if (audioSamples === 0) {
      await assert.rejects(prepareNativeMp4File(state.options, state.dependencies), (error) => {
        assert.equal(error.code, "INVALID_OPTIONS");
        assert.equal(error.details.reason, "RANGE_TOO_SHORT");
        assert.equal(error.details.streamKind, "audio");
        return true;
      });

      assert.deepEqual(state.events, ["probe-input", "analyze"]);
    } else {
      await prepareNativeMp4File(state.options, state.dependencies);

      assert.deepEqual(state.events, ["probe-input", "analyze", "encode", "probe-output"]);
    }
  }
});

function enableResizePreparation(state) {
  state.source.streams[0].sampleAspectRatio = "1:1";
  state.source.streams[0].defaultOrientation = true;

  state.encoded.streams[0].sampleAspectRatio = "1:1";
  state.encoded.streams[0].defaultOrientation = true;

  state.options.inventory.filters = ["scale", "setsar"];
  state.options.plan.transformations = [{ type: "resize", options: { width: 160, height: 90 } }];
}

test("resize preparation validates the planned output dimensions", async () => {
  const state = setup();
  enableResizePreparation(state);
  state.encoded.metadata.streams[0].width = 160;
  state.encoded.metadata.streams[0].height = 90;

  const result = await prepareNativeMp4File(state.options, state.dependencies);

  assert.equal(result.metadata.streams[0].width, 160);
  assert.equal(result.metadata.streams[0].height, 90);
  assert.deepEqual(state.events, ["probe-input", "encode", "probe-output"]);
});

test("resize preparation rejects output that retained the source dimensions", async () => {
  const state = setup();
  enableResizePreparation(state);

  await assert.rejects(prepareNativeMp4File(state.options, state.dependencies), (error) => {
    assert.equal(error.code, "EXECUTION_FAILED");
    assert.equal(error.details.reason, "OUTPUT_DIMENSIONS_MISMATCH");
    return true;
  });

  assert.deepEqual(state.events, ["probe-input", "encode", "probe-output"]);
});

test("resized bytes are not read when output geometry is invalid", async () => {
  for (const [field, value, reason] of [
    ["sampleAspectRatio", "4:3", "OUTPUT_SAMPLE_ASPECT_RATIO_MISMATCH"],
    ["defaultOrientation", false, "OUTPUT_ORIENTATION_MISMATCH"],
  ]) {
    const state = setup();
    enableResizePreparation(state);

    state.encoded.metadata.streams[0].width = 160;
    state.encoded.metadata.streams[0].height = 90;
    state.encoded.streams[0][field] = value;

    await assert.rejects(prepareNativeMp4Bytes(state.options, state.dependencies), (error) => {
      assert.equal(error.code, "EXECUTION_FAILED");
      assert.equal(error.details.reason, reason);
      return true;
    });

    assert.deepEqual(state.events, ["probe-input", "encode", "probe-output"]);
  }
});

test("small-preset preparation validates output before returning bytes", async () => {
  for (const validOutput of [true, false]) {
    const state = setup();
    state.options.plan.terminal.preset = "video-small-v1";
    state.options.plan.transformations = [
      { type: "compress", options: { preset: "video-small-v1" } },
    ];

    if (!validOutput) {
      state.encoded.metadata.streams[0].codec = "hevc";
    }

    if (validOutput) {
      const result = await prepareNativeMp4Bytes(state.options, state.dependencies);

      assert.deepEqual([...result.bytes], [1, 2, 3]);
      assert.deepEqual(state.events, ["probe-input", "encode", "probe-output", "read"]);
    } else {
      await assert.rejects(prepareNativeMp4Bytes(state.options, state.dependencies), (error) => {
        assert.equal(error.code, "EXECUTION_FAILED");
        assert.equal(error.details.reason, "OUTPUT_VIDEO_CODEC_MISMATCH");
        assert.equal(error.details.preset, "video-small-v1");
        return true;
      });

      assert.deepEqual(state.events, ["probe-input", "encode", "probe-output"]);
    }
  }
});
