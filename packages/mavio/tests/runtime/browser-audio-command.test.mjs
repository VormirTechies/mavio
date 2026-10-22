import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserAudioCommand } from "../../dist/engines/browser/audio-command.js";

function fixture(preset = "audio-balanced-v1") {
  const format = preset === "audio-balanced-v1" ? "mp3" : "wav";

  return {
    inputPath: "/mavio-audio-test/input.bin",
    outputPath: `/mavio-audio-test/output.${format}`,

    inventory: {
      encoders: ["libmp3lame", "pcm_s16le"],
      decoders: ["aac", "pcm_s16le"],
      muxers: ["mp3", "wav"],
      demuxers: ["mov", "wav"],
      filters: [],
    },

    plan: {
      input: {
        kind: "bytes",
        bytes: new Uint8Array([1]),
      },
      transformations: [],
      terminal: {
        type: "export",
        format,
        preset,
      },
      output: { kind: "bytes" },
    },

    source: {
      metadata: {
        container: "mov,mp4,m4a,3gp,3g2,mj2",
        durationSeconds: 1,
        streams: [
          {
            index: 0,
            kind: "video",
            codec: "h264",
          },
          {
            index: 7,
            kind: "audio",
            codec: "aac",
            sampleRate: 48000,
            channels: 2,
          },
          {
            index: 2,
            kind: "audio",
            codec: "aac",
            sampleRate: 44100,
            channels: 1,
          },
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

test("browser audio commands map the first audio stream for both presets", () => {
  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    const options = fixture(preset);
    const args = buildBrowserAudioCommand(options);

    assert.deepEqual(values(args, "-map"), ["0:7"]);
    assert.deepEqual(values(args, "-ar:a:0"), ["48000"]);
    assert.deepEqual(values(args, "-ac:a:0"), ["2"]);
    assert.deepEqual(values(args, "-channel_layout:a:0"), ["stereo"]);

    assert.deepEqual(values(args, "-c:a"), [
      preset === "audio-balanced-v1" ? "libmp3lame" : "pcm_s16le",
    ]);

    assert.equal(args.at(-1), options.outputPath);
  }
});

test("browser extraction honors absolute stream indexes", () => {
  const options = fixture();

  options.plan.transformations = [
    {
      type: "extractAudio",
      options: { streamIndex: 2 },
    },
    {
      type: "convert",
      options: {
        format: "mp3",
        preset: "audio-balanced-v1",
      },
    },
  ];

  const args = buildBrowserAudioCommand(options);

  assert.deepEqual(values(args, "-map"), ["0:2"]);
  assert.deepEqual(values(args, "-ar:a:0"), ["44100"]);
  assert.deepEqual(values(args, "-ac:a:0"), ["1"]);
  assert.deepEqual(values(args, "-channel_layout:a:0"), ["mono"]);
});

test("browser PCM WAV re-input accepts implicit standard stereo layout", () => {
  const options = fixture("audio-pcm-v1");

  options.source.metadata.container = "wav";

  options.source.metadata.streams = [
    {
      index: 7,
      kind: "audio",
      codec: "pcm_s16le",
      sampleRate: 48000,
      channels: 2,
    },
  ];

  options.source.streams = [{ index: 7 }];
  options.inventory.encoders = ["pcm_s16le"];
  options.inventory.decoders = ["pcm_s16le"];
  options.inventory.muxers = ["wav"];

  const args = buildBrowserAudioCommand(options);

  assert.deepEqual(values(args, "-map"), ["0:7"]);
  assert.deepEqual(values(args, "-channel_layout:a:0"), ["stereo"]);
  assert.deepEqual(values(args, "-f"), ["wav"]);
  assert.equal(args.includes("-b:a"), false);
});

test("browser audio rejects video, absent and malformed stream indexes", () => {
  for (const streamIndex of [0, 99, -1, 1.5]) {
    const options = fixture();

    options.plan.transformations = [
      {
        type: "extractAudio",
        options: { streamIndex },
      },
    ];

    assert.throws(() => buildBrowserAudioCommand(options), {
      code: "INVALID_OPTIONS",
      details: {
        reason: "INVALID_STREAM_INDEX",
      },
    });
  }
});

test("browser audio rejects a source with no audio", () => {
  const options = fixture();

  options.source.metadata.streams = [{ index: 0, kind: "video", codec: "h264" }];

  options.source.streams = [{ index: 0 }];

  assert.throws(() => buildBrowserAudioCommand(options), {
    code: "INVALID_MEDIA",
    details: { reason: "MISSING_AUDIO" },
  });
});

test("browser audio rejects unsupported source profiles and missing decoders", () => {
  for (const [modify, reason] of [
    [
      (options) => {
        options.source.metadata.streams[1].sampleRate = 96000;
      },
      "UNSUPPORTED_AUDIO_SAMPLE_RATE",
    ],
    [
      (options) => {
        options.source.streams[1].channelLayout = "5.1";
      },
      "UNSUPPORTED_AUDIO_LAYOUT",
    ],
    [
      (options) => {
        options.source.streams = options.source.streams.filter((stream) => stream.index !== 7);
      },
      "MISSING_STREAM_DETAILS",
    ],
    [
      (options) => {
        options.inventory.decoders = [];
      },
      "MISSING_SOURCE_DECODER",
    ],
  ]) {
    const options = fixture();
    modify(options);

    assert.throws(
      () => buildBrowserAudioCommand(options),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
        assert.equal(error.details.reason, reason);
        assert.equal(error.details.streamIndex, 7);
        return true;
      },
    );
  }
});

test("browser audio rejects conflicting and duplicate encoding declarations", () => {
  const mismatch = fixture();
  mismatch.plan.terminal.format = "wav";

  assert.throws(() => buildBrowserAudioCommand(mismatch), {
    code: "INVALID_OPTIONS",
    details: {
      reason: "TERMINAL_FORMAT_MISMATCH",
    },
  });

  const conflicting = fixture();

  conflicting.plan.transformations = [
    {
      type: "compress",
      options: { preset: "audio-pcm-v1" },
    },
  ];

  assert.throws(() => buildBrowserAudioCommand(conflicting), {
    code: "INVALID_OPTIONS",
    details: {
      reason: "AUDIO_ENCODING_MISMATCH",
    },
  });

  const duplicate = fixture();

  duplicate.plan.transformations = [
    { type: "extractAudio", options: {} },
    { type: "extractAudio", options: {} },
  ];

  assert.throws(() => buildBrowserAudioCommand(duplicate), {
    code: "INVALID_OPTIONS",
    details: {
      reason: "DUPLICATE_AUDIO_TRANSFORMATION",
    },
  });
});

test("browser audio rejects pending transformations and unsafe paths or IO", () => {
  for (const transformation of [
    {
      type: "resize",
      options: { width: 160, height: 90 },
    },
  ]) {
    const options = fixture();
    options.plan.transformations = [transformation];

    assert.throws(() => buildBrowserAudioCommand(options), {
      code: "UNSUPPORTED_CAPABILITY",
      operation: transformation.type,
      details: {
        reason: "BROWSER_AUDIO_TRANSFORMATION_PENDING",
        operationIndex: 0,
      },
    });
  }

  for (const [inputPath, outputPath] of [
    ["/mavio-audio-test/input.bin", "/mavio-other/output.mp3"],
    ["/mavio-audio-test/input.bin", "/mavio-audio-test/input.bin"],
    ["/mavio-audio-test/input.bin", "/mavio-audio-test/output.wav"],
    ["/mavio-audio-test/../input.bin", "/mavio-audio-test/output.mp3"],
  ]) {
    const options = {
      ...fixture(),
      inputPath,
      outputPath,
    };

    assert.throws(() => buildBrowserAudioCommand(options), {
      code: "INVALID_OPTIONS",
      details: {
        reason: "INVALID_BROWSER_COMMAND_PATH",
      },
    });
  }

  const unsupportedIO = fixture();

  unsupportedIO.plan.input = {
    kind: "path",
    path: "source.wav",
  };

  assert.throws(() => buildBrowserAudioCommand(unsupportedIO), {
    code: "UNSUPPORTED_CAPABILITY",
    details: {
      reason: "UNSUPPORTED_BROWSER_IO",
    },
  });
});

test("browser audio commands are immutable and avoid wrapper overwrite conflicts", () => {
  const options = fixture();
  const before = structuredClone(options);

  const args = buildBrowserAudioCommand(options);

  assert.equal(Object.isFrozen(args), true);
  assert.deepEqual(options, before);

  for (const flag of ["-vn", "-sn", "-dn", "-xerror"]) {
    assert.equal(args.includes(flag), true);
  }

  for (const flag of ["-map_metadata", "-map_metadata:s", "-map_chapters"]) {
    assert.deepEqual(values(args, flag), ["-1"]);
  }

  assert.deepEqual(values(args, "-protocol_whitelist"), ["file"]);

  assert.deepEqual(values(args, "-threads:a"), ["1"]);

  for (const flag of ["-n", "-y", "-af", "-vf", "-ss", "-t"]) {
    assert.equal(args.includes(flag), false);
  }
});

function trimmedFixture(preset = "audio-balanced-v1") {
  const options = fixture(preset);

  options.source.formatStartTimeSeconds = 0;
  options.inventory.filters = ["atrim", "asetpts"];
  options.plan.transformations = [
    {
      type: "trim",
      options: { start: 0.125, end: 0.625 },
    },
  ];

  return options;
}

test("both browser audio presets encode trim with the requested time origin", () => {
  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    const options = trimmedFixture(preset);
    const before = structuredClone(options);
    const args = buildBrowserAudioCommand(options);

    assert.deepEqual(values(args, "-af"), [
      "atrim=start=125000us:end=625000us," + "asetpts=PTS-125000/(1000000*TB)",
    ]);

    assert.equal(args.filter((arg) => arg === "-copyts").length, 1);
    assert.ok(args.indexOf("-copyts") < args.indexOf("-i"));

    assert.deepEqual(values(args, "-map"), ["0:7"]);
    assert.deepEqual(values(args, "-ar:a:0"), ["48000"]);
    assert.deepEqual(values(args, "-ac:a:0"), ["2"]);

    for (const flag of ["-ss", "-t", "-vf", "-n", "-y"]) {
      assert.equal(args.includes(flag), false);
    }

    assert.equal(Object.isFrozen(args), true);
    assert.deepEqual(options, before);
  }
});

test("consecutive browser audio trims produce one filter chain", () => {
  const options = trimmedFixture();

  options.plan.transformations = [
    { type: "trim", options: { start: 0.125, end: 0.875 } },
    { type: "trim", options: { start: 0.125, end: 0.375 } },
  ];

  const args = buildBrowserAudioCommand(options);

  assert.deepEqual(values(args, "-af"), [
    "atrim=start=250000us:end=500000us," + "asetpts=PTS-250000/(1000000*TB)",
  ]);
});

test("browser audio trim preserves explicit audio stream selection", () => {
  const options = trimmedFixture("audio-pcm-v1");

  options.plan.transformations.unshift({
    type: "extractAudio",
    options: { streamIndex: 2 },
  });

  const args = buildBrowserAudioCommand(options);

  assert.deepEqual(values(args, "-map"), ["0:2"]);
  assert.deepEqual(values(args, "-ar:a:0"), ["44100"]);
  assert.deepEqual(values(args, "-ac:a:0"), ["1"]);
  assert.deepEqual(values(args, "-channel_layout:a:0"), ["mono"]);
  assert.equal(values(args, "-af").length, 1);
});

test("browser audio trim commands require both audio timing filters", () => {
  for (const missing of ["atrim", "asetpts"]) {
    const options = trimmedFixture();

    options.inventory.filters = ["atrim", "asetpts"].filter((name) => name !== missing);

    assert.throws(() => buildBrowserAudioCommand(options), {
      code: "UNSUPPORTED_CAPABILITY",
      details: {
        reason: "MISSING_FILTER",
        filter: missing,
      },
    });
  }
});

test("browser audio trim commands reject unknown duration and unsupported origins", () => {
  const duration = trimmedFixture();
  delete duration.source.metadata.durationSeconds;

  assert.throws(() => buildBrowserAudioCommand(duration), {
    code: "INVALID_MEDIA",
    details: {
      reason: "UNKNOWN_DURATION",
      operationIndex: 0,
    },
  });

  for (const origin of [undefined, -1, 0.5]) {
    const options = trimmedFixture();
    options.source.formatStartTimeSeconds = origin;

    assert.throws(() => buildBrowserAudioCommand(options), {
      code: "UNSUPPORTED_CAPABILITY",
      details: { reason: "UNSUPPORTED_TIME_ORIGIN" },
    });
  }
});

test("browser PCM WAV trim accepts its implicit zero timestamp origin", () => {
  const options = trimmedFixture("audio-pcm-v1");

  options.source.metadata.container = "wav";
  options.source.metadata.streams = [
    {
      index: 7,
      kind: "audio",
      codec: "pcm_s16le",
      sampleRate: 48000,
      channels: 2,
    },
  ];

  options.source.streams = [{ index: 7 }];
  delete options.source.formatStartTimeSeconds;

  const args = buildBrowserAudioCommand(options);

  assert.equal(args.includes("-copyts"), true);
  assert.equal(values(args, "-af").length, 1);
  assert.deepEqual(values(args, "-channel_layout:a:0"), ["stereo"]);
});
