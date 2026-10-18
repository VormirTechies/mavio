import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { prepareNativeAudioBytes } from "../../dist/engines/native/audio-bytes.js";

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
        events.push("read");
        return new Uint8Array(100).fill(23);
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

test("audio byte preparation returns validated independent bytes for both presets", async () => {
  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    const f = fixture(preset);
    const backing = new Uint8Array(104).fill(23);
    const view = backing.subarray(2, 102);

    f.options.workspace.readOutput = async () => {
      f.events.push("read");
      return view;
    };

    const result = await prepareNativeAudioBytes(f.options, f.dependencies);

    assert.equal(result.bytes.byteLength, 100);
    assert.deepEqual(result.bytes, new Uint8Array(100).fill(23));
    assert.deepEqual(result.metadata, f.encoded.metadata);
    assert.notEqual(result.bytes.buffer, backing.buffer);

    // Simulate the caller releasing or reusing workspace-owned storage.
    f.options.workspace.dispose = async () => {
      backing.fill(0);
    };
    await f.options.workspace.dispose();

    assert.deepEqual(result.bytes, new Uint8Array(100).fill(23));
    assert.deepEqual(f.events, ["stage", "probe-input", "encode", "probe-output", "read"]);
  }
});

test("audio byte preparation rejects path output before doing work", async () => {
  const f = fixture();
  f.options.plan.output = {
    kind: "path",
    path: resolve("public audio.mp3"),
  };

  await assert.rejects(prepareNativeAudioBytes(f.options, f.dependencies), {
    code: "UNSUPPORTED_CAPABILITY",
    details: { reason: "UNSUPPORTED_NATIVE_IO" },
  });

  assert.deepEqual(f.events, []);
});

test("audio byte preparation rejects output size changes", async () => {
  for (const size of [0, 99, 101]) {
    const f = fixture();

    f.options.workspace.readOutput = async () => {
      f.events.push("read");
      return new Uint8Array(size);
    };

    await assert.rejects(prepareNativeAudioBytes(f.options, f.dependencies), {
      code: "EXECUTION_FAILED",
      stage: "finalizing",
      details: { reason: "OUTPUT_SIZE_CHANGED" },
    });

    assert.equal(f.events.at(-1), "read");
  }
});

test("audio byte preparation honors cancellation during readback", async () => {
  const f = fixture();
  const reason = new Error("Cancelled during readback");

  f.options.workspace.readOutput = async () => {
    f.events.push("read");
    f.controller.abort(reason);
    return new Uint8Array(100);
  };

  await assert.rejects(prepareNativeAudioBytes(f.options, f.dependencies), (error) => {
    assert.equal(error.code, "CANCELLED");
    assert.equal(error.stage, "finalizing");
    assert.equal(error.cause, reason);
    return true;
  });

  assert.equal(f.events.at(-1), "read");
});

test("audio byte preparation preserves read failures and caller cleanup ownership", async () => {
  const f = fixture();
  const failure = new Error("Read failed");

  f.options.workspace.readOutput = async () => {
    f.events.push("read");
    throw failure;
  };

  await assert.rejects(
    prepareNativeAudioBytes(f.options, f.dependencies),
    (error) => error === failure,
  );

  assert.deepEqual(f.events, ["stage", "probe-input", "encode", "probe-output", "read"]);
});

test("audio byte preparation never reads an output that fails validation", async () => {
  const f = fixture();
  f.encoded.metadata.streams[0].codec = "aac";

  await assert.rejects(prepareNativeAudioBytes(f.options, f.dependencies), {
    code: "EXECUTION_FAILED",
    details: {
      reason: "OUTPUT_AUDIO_CODEC_MISMATCH",
      preset: "audio-balanced-v1",
    },
  });

  assert.deepEqual(f.events, ["stage", "probe-input", "encode", "probe-output"]);
});
