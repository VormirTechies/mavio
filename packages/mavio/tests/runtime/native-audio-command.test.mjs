import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { buildNativeAudioCommand } from "../../dist/engines/native/audio-command.js";

function options(preset = "audio-balanced-v1") {
  return {
    inputPath: resolve("source with spaces & symbols.mp4"),
    outputPath: resolve("private audio output.bin"),
    inventory: {
      encoders: ["libmp3lame", "pcm_s16le"],
      decoders: [],
      muxers: ["mp3", "wav"],
      demuxers: [],
      filters: [],
    },
    plan: {
      input: { kind: "bytes", bytes: new Uint8Array([1]) },
      transformations: [],
      terminal: {
        type: "export",
        format: preset === "audio-balanced-v1" ? "mp3" : "wav",
        preset,
      },
      output: { kind: "bytes" },
    },
    source: {
      metadata: {
        streams: [
          { index: 0, kind: "video" },
          { index: 7, kind: "audio", sampleRate: 48000, channels: 2 },
          { index: 2, kind: "audio", sampleRate: 44100, channels: 1 },
        ],
      },
      streams: [
        { index: 0 },
        { index: 7, channelLayout: "stereo" },
        { index: 2, channelLayout: "mono" },
      ],
    },
  };
}

function values(args, flag) {
  return args.flatMap((value, index) => (value === flag ? [args[index + 1]] : []));
}

test("MP3 command maps first audio and preserves settings without mutating the plan", () => {
  const input = options();
  const before = structuredClone(input);
  const args = buildNativeAudioCommand(input);

  assert.deepEqual(values(args, "-map"), ["0:7"]);
  assert.deepEqual(values(args, "-ar:a:0"), ["48000"]);
  assert.deepEqual(values(args, "-ac:a:0"), ["2"]);
  assert.deepEqual(values(args, "-channel_layout:a:0"), ["stereo"]);
  assert.deepEqual(values(args, "-c:a"), ["libmp3lame"]);
  assert.deepEqual(values(args, "-b:a"), ["128k"]);
  assert.deepEqual(values(args, "-f"), ["mp3"]);
  assert.deepEqual(values(args, "-i"), [input.inputPath]);
  assert.equal(args.at(-1), input.outputPath);
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(args), true);

  for (const flag of ["-vn", "-sn", "-dn", "-n", "-nostdin", "-xerror"]) {
    assert.equal(args.includes(flag), true);
  }

  for (const flag of ["-map_metadata", "-map_metadata:s", "-map_chapters"]) {
    assert.deepEqual(values(args, flag), ["-1"]);
  }

  assert.deepEqual(values(args, "-protocol_whitelist"), ["file"]);

  for (const flag of ["-y", "-an", "-shortest", "-ss", "-t", "-af", "-vf"]) {
    assert.equal(args.includes(flag), false);
  }
});

test("audio command honors explicit absolute stream selection", () => {
  const input = options();

  input.plan.transformations = [
    { type: "extractAudio", options: { streamIndex: 2 } },
    {
      type: "convert",
      options: { format: "mp3", preset: "audio-balanced-v1" },
    },
    { type: "compress", options: { preset: "audio-balanced-v1" } },
  ];

  const args = buildNativeAudioCommand(input);

  assert.deepEqual(values(args, "-map"), ["0:2"]);
  assert.deepEqual(values(args, "-ar:a:0"), ["44100"]);
  assert.deepEqual(values(args, "-ac:a:0"), ["1"]);
  assert.deepEqual(values(args, "-channel_layout:a:0"), ["mono"]);
});

test("WAV command uses PCM and needs no MP3 encoder or muxer", () => {
  const input = options("audio-pcm-v1");

  input.inventory.encoders = ["pcm_s16le"];
  input.inventory.muxers = ["wav"];
  input.source.metadata.streams = [{ index: 7, kind: "audio", sampleRate: 48000, channels: 2 }];
  input.source.streams = [{ index: 7, channelLayout: "stereo" }];

  const args = buildNativeAudioCommand(input);

  assert.deepEqual(values(args, "-c:a"), ["pcm_s16le"]);
  assert.deepEqual(values(args, "-f"), ["wav"]);
  assert.deepEqual(values(args, "-map"), ["0:7"]);
  assert.equal(args.includes("-b:a"), false);
});

test("audio command rejects conflicting encoding declarations", () => {
  const input = options();
  input.plan.terminal.format = "wav";

  assert.throws(() => buildNativeAudioCommand(input), {
    code: "INVALID_OPTIONS",
    details: { reason: "TERMINAL_FORMAT_MISMATCH" },
  });

  for (const transformation of [
    { type: "compress", options: { preset: "audio-pcm-v1" } },
    {
      type: "convert",
      options: { format: "wav", preset: "audio-balanced-v1" },
    },
  ]) {
    const conflicting = options();
    conflicting.plan.transformations = [transformation];

    assert.throws(() => buildNativeAudioCommand(conflicting), {
      code: "INVALID_OPTIONS",
      details: { reason: "AUDIO_ENCODING_MISMATCH" },
    });
  }
});

test("audio command rejects pending and duplicate transformations", () => {
  for (const transformation of [{ type: "resize", options: { width: 160, height: 90 } }]) {
    const input = options();
    input.plan.transformations = [transformation];

    assert.throws(() => buildNativeAudioCommand(input), {
      code: "UNSUPPORTED_CAPABILITY",
      operation: transformation.type,
      details: {
        reason: "NATIVE_TRANSFORMATION_PENDING",
        operationIndex: 0,
      },
    });
  }

  for (const transformation of [
    { type: "extractAudio", options: {} },
    { type: "compress", options: { preset: "audio-balanced-v1" } },
    {
      type: "convert",
      options: { format: "mp3", preset: "audio-balanced-v1" },
    },
  ]) {
    const input = options();
    input.plan.transformations = [transformation, transformation];

    assert.throws(() => buildNativeAudioCommand(input), {
      code: "INVALID_OPTIONS",
      details: { reason: "DUPLICATE_AUDIO_TRANSFORMATION" },
    });
  }
});

test("audio command requires distinct fully qualified paths", () => {
  for (const field of ["inputPath", "outputPath"]) {
    for (const path of ["relative.mp3", `${resolve("audio")}\0.mp3`]) {
      const input = options();
      input[field] = path;

      assert.throws(() => buildNativeAudioCommand(input), {
        code: "INVALID_OPTIONS",
        details: { reason: "INVALID_NATIVE_COMMAND_PATH" },
      });
    }
  }

  const input = options();
  input.outputPath = input.inputPath;

  assert.throws(() => buildNativeAudioCommand(input), {
    code: "INVALID_OPTIONS",
    details: { reason: "INPUT_OUTPUT_PATH_CONFLICT" },
  });
});

test("audio command enforces stream, source profile and encoder guards", () => {
  const absent = options();
  absent.plan.transformations = [{ type: "extractAudio", options: { streamIndex: 99 } }];

  assert.throws(() => buildNativeAudioCommand(absent), {
    code: "INVALID_OPTIONS",
    details: { reason: "INVALID_STREAM_INDEX" },
  });

  const unsupported = options();
  unsupported.source.metadata.streams[1].sampleRate = 96000;

  assert.throws(() => buildNativeAudioCommand(unsupported), {
    code: "UNSUPPORTED_CAPABILITY",
    details: {
      reason: "UNSUPPORTED_AUDIO_SAMPLE_RATE",
      streamIndex: 7,
      preset: "audio-balanced-v1",
    },
  });

  const unavailable = options();
  unavailable.inventory.encoders = ["pcm_s16le"];

  assert.throws(() => buildNativeAudioCommand(unavailable), {
    code: "UNSUPPORTED_CAPABILITY",
    details: {
      reason: "MISSING_ENCODER",
      component: "libmp3lame",
      preset: "audio-balanced-v1",
    },
  });
});

test("audio command combines consecutive trims into one filter chain", () => {
  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    const input = options(preset);

    input.source.metadata.durationSeconds = 2;
    input.source.formatStartTimeSeconds = 0;
    input.inventory.filters = ["atrim", "asetpts"];
    input.plan.transformations = [
      { type: "trim", options: { start: 0.25, end: 1.75 } },
      { type: "extractAudio", options: { streamIndex: 2 } },
      { type: "trim", options: { start: 0.25, end: 0.75 } },
    ];

    const args = buildNativeAudioCommand(input);

    assert.deepEqual(values(args, "-map"), ["0:2"]);
    assert.deepEqual(values(args, "-af"), [
      "atrim=start=500000us:end=1000000us,asetpts=PTS-500000/(1000000*TB)",
    ]);
    assert.equal(args.filter((value) => value === "-copyts").length, 1);
    assert.ok(args.indexOf("-copyts") < args.indexOf("-i"));
    assert.equal(args.includes("-vf"), false);
    assert.equal(args.includes("-ss"), false);
    assert.equal(args.includes("-t"), false);
  }
});

test("audio command rejects trims beyond the source duration", () => {
  const input = options();

  input.source.metadata.durationSeconds = 1;
  input.source.formatStartTimeSeconds = 0;
  input.inventory.filters = ["atrim", "asetpts"];
  input.plan.transformations = [{ type: "trim", options: { start: 0.25, end: 2 } }];

  assert.throws(() => buildNativeAudioCommand(input), {
    code: "INVALID_OPTIONS",
    details: { reason: "OUT_OF_RANGE", operationIndex: 0 },
  });
});
