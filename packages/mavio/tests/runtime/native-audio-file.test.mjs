import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { prepareNativeAudioFile } from "../../dist/engines/native/audio-file.js";

function fixture(preset = "audio-balanced-v1") {
  const events = [];
  const controller = new AbortController();
  const inputPath = resolve("staged input.bin");
  const outputPath = resolve("private output.mp4");
  const bytes = new Uint8Array([1, 2, 3]);

  const source = {
    metadata: {
      streams: [{ index: 7, kind: "audio", sampleRate: 48000, channels: 2 }],
    },
    streams: [{ index: 7, channelLayout: "stereo" }],
  };

  const encoded = {
    metadata: {
      container: preset === "audio-balanced-v1" ? "mp3" : "wav",
      durationSeconds: 1,
      sizeBytes: 100,
      streams: [
        {
          index: 0,
          kind: "audio",
          codec: preset === "audio-balanced-v1" ? "mp3" : "pcm_s16le",
          sampleRate: 48000,
          channels: 2,
        },
      ],
    },
    streams: [{ index: 0, channelLayout: "stereo" }],
  };

  const options = {
    configuration: { cwd: resolve(".") },
    tools: {},
    inventory: {
      encoders: ["libmp3lame", "pcm_s16le"],
      decoders: [],
      muxers: ["mp3", "wav"],
      demuxers: [],
      filters: [],
    },
    plan: {
      input: { kind: "bytes", bytes },
      transformations: [],
      terminal: {
        type: "export",
        format: preset === "audio-balanced-v1" ? "mp3" : "wav",
        preset,
      },
      output: { kind: "bytes" },
    },
    context: {
      jobId: "audio-file-test",
      signal: controller.signal,
    },
    workspace: {
      async writeInput(value) {
        events.push("stage");
        assert.deepEqual(value, bytes);
        return inputPath;
      },
      getOutputPath() {
        return outputPath;
      },
      async readOutput() {
        assert.fail("File preparation must not read output bytes.");
      },
      async dispose() {
        assert.fail("Workspace cleanup belongs to the caller.");
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
    async execute(_configuration, _tools, command, context) {
      events.push("encode");
      assert.equal(command.inputPath, inputPath);
      assert.equal(command.outputPath, outputPath);
      assert.equal(context.signal, controller.signal);
    },
  };

  return {
    options,
    dependencies,
    events,
    controller,
    inputPath,
    outputPath,
    source,
    encoded,
    bytes,
  };
}

test("audio byte input is staged and returns a validated file without reading or cleanup", async () => {
  const f = fixture();
  const before = f.bytes.slice();

  const result = await prepareNativeAudioFile(f.options, f.dependencies);

  assert.deepEqual(result, {
    path: f.outputPath,
    metadata: f.encoded.metadata,
  });
  assert.deepEqual(f.events, ["stage", "probe-input", "encode", "probe-output"]);
  assert.deepEqual(f.bytes, before);
});

test("WAV path preparation skips staging and does not publish the final target", async () => {
  const f = fixture("audio-pcm-v1");

  f.options.plan.input = { kind: "path", path: f.inputPath };
  f.options.plan.output = {
    kind: "path",
    path: resolve("public target.wav"),
  };
  delete f.encoded.streams[0].channelLayout;

  const result = await prepareNativeAudioFile(f.options, f.dependencies);

  assert.equal(result.path, f.outputPath);
  assert.notEqual(result.path, f.options.plan.output.path);
  assert.deepEqual(f.events, ["probe-input", "encode", "probe-output"]);
});

test("invalid audio profiles and pending transformations reject before encoding", async () => {
  for (const mode of ["profile", "resize"]) {
    const f = fixture();

    if (mode === "profile") {
      f.source.metadata.streams[0].sampleRate = 96000;
    } else {
      f.options.plan.transformations = [{ type: "resize", options: { width: 160, height: 90 } }];
    }

    await assert.rejects(prepareNativeAudioFile(f.options, f.dependencies), {
      code: "UNSUPPORTED_CAPABILITY",
    });

    assert.deepEqual(f.events, ["stage", "probe-input"]);
  }
});

test("audio preparation rejects output that fails validation", async () => {
  const f = fixture();
  f.encoded.metadata.streams[0].codec = "aac";

  await assert.rejects(prepareNativeAudioFile(f.options, f.dependencies), {
    code: "EXECUTION_FAILED",
    stage: "finalizing",
    jobId: "audio-file-test",
    details: {
      reason: "OUTPUT_AUDIO_CODEC_MISMATCH",
      preset: "audio-balanced-v1",
    },
  });

  assert.deepEqual(f.events, ["stage", "probe-input", "encode", "probe-output"]);
});

test("audio preparation stops after cancellation at asynchronous boundaries", async () => {
  for (const boundary of ["before", "stage", "probe-input", "encode", "probe-output"]) {
    const f = fixture();
    const reason = new Error(`Cancelled at ${boundary}`);

    if (boundary === "before") {
      f.controller.abort(reason);
    } else if (boundary === "stage") {
      const original = f.options.workspace.writeInput;
      f.options.workspace.writeInput = async (...args) => {
        const result = await original(...args);
        f.controller.abort(reason);
        return result;
      };
    } else if (boundary === "encode") {
      const original = f.dependencies.execute;
      f.dependencies.execute = async (...args) => {
        await original(...args);
        f.controller.abort(reason);
      };
    } else {
      const original = f.dependencies.probe;
      f.dependencies.probe = async (...args) => {
        const result = await original(...args);
        if (f.events.at(-1) === boundary) f.controller.abort(reason);
        return result;
      };
    }

    await assert.rejects(prepareNativeAudioFile(f.options, f.dependencies), (error) => {
      assert.equal(error.code, "CANCELLED");
      assert.equal(error.cause, reason);
      return true;
    });

    const order = ["stage", "probe-input", "encode", "probe-output"];
    assert.deepEqual(
      f.events,
      boundary === "before" ? [] : order.slice(0, order.indexOf(boundary) + 1),
    );
  }
});

test("audio execution failure is preserved without output probing or caller cleanup", async () => {
  const f = fixture();
  const failure = new Error("Encoder failed");

  f.dependencies.execute = async () => {
    f.events.push("encode");
    throw failure;
  };

  await assert.rejects(
    prepareNativeAudioFile(f.options, f.dependencies),
    (error) => error === failure,
  );

  assert.deepEqual(f.events, ["stage", "probe-input", "encode"]);
});

function enableAudioTrim(f) {
  f.source.metadata.durationSeconds = 1;
  f.source.formatStartTimeSeconds = 0;
  f.options.inventory.filters = ["atrim", "asetpts"];
  f.options.inventory.encoders.push("pcm_f32le");
  f.options.inventory.muxers.push("framemd5");
  f.options.plan.transformations = [{ type: "trim", options: { start: 0.25, end: 0.75 } }];
}

test("audio preparation analyzes the selected interval before encoding", async () => {
  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    const f = fixture(preset);
    enableAudioTrim(f);

    f.dependencies.analyzeTrim = async (request) => {
      f.events.push("analyze");
      assert.equal(request.inputPath, f.inputPath);
      assert.equal(request.streamIndex, 7);
      assert.equal(request.channels, 2);
      assert.equal(
        request.filters.audio,
        "atrim=start=250000us:end=750000us,asetpts=PTS-250000/(1000000*TB)",
      );
      return { audioSamples: 24000 };
    };

    const result = await prepareNativeAudioFile(f.options, f.dependencies);

    assert.equal(result.path, f.outputPath);
    assert.deepEqual(f.events, ["stage", "probe-input", "analyze", "encode", "probe-output"]);
  }
});

test("audio preparation rejects empty and malformed sample counts before encoding", async () => {
  for (const count of [0, -1, 1.5, NaN, Infinity, undefined]) {
    const f = fixture();
    enableAudioTrim(f);

    f.dependencies.analyzeTrim = async () => {
      f.events.push("analyze");
      return { audioSamples: count };
    };

    await assert.rejects(prepareNativeAudioFile(f.options, f.dependencies), (error) => {
      assert.equal(error.code, count === 0 ? "INVALID_OPTIONS" : "EXECUTION_FAILED");
      assert.equal(
        error.details.reason,
        count === 0 ? "RANGE_TOO_SHORT" : "INVALID_TRIM_SELECTION",
      );
      return true;
    });

    assert.deepEqual(f.events, ["stage", "probe-input", "analyze"]);
  }
});

test("cancellation during audio trim analysis prevents encoding", async () => {
  const f = fixture();
  enableAudioTrim(f);
  const reason = new Error("Cancelled during analysis");

  f.dependencies.analyzeTrim = async () => {
    f.events.push("analyze");
    f.controller.abort(reason);
    return { audioSamples: 24000 };
  };

  await assert.rejects(prepareNativeAudioFile(f.options, f.dependencies), (error) => {
    assert.equal(error.code, "CANCELLED");
    assert.equal(error.cause, reason);
    return true;
  });

  assert.deepEqual(f.events, ["stage", "probe-input", "analyze"]);
});
