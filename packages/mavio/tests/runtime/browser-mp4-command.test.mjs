import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserMp4Command } from "../../dist/engines/browser/mp4-command.js";

function fixture() {
  return {
    plan: {
      input: { kind: "bytes", bytes: new Uint8Array([1]) },
      transformations: [],
      terminal: {
        type: "export",
        format: "mp4",
        preset: "video-balanced-v1",
      },
      output: { kind: "bytes" },
    },

    source: {
      metadata: {
        durationSeconds: 1,
        streams: [
          {
            index: 2,
            kind: "video",
            codec: "h264",
            width: 320,
            height: 180,
          },
          {
            index: 5,
            kind: "audio",
            codec: "aac",
            sampleRate: 48000,
            channels: 2,
          },
        ],
      },
      formatStartTimeSeconds: 0,
      streams: [
        {
          index: 2,
          pixelFormat: "yuv420p",
          colorTransfer: "bt709",
          colorPrimaries: "bt709",
          colorSpace: "bt709",
          colorRange: "tv",
          sampleAspectRatio: "1:1",
          attachedPicture: false,
          defaultOrientation: true,
        },
        { index: 5, channelLayout: "stereo" },
      ],
    },

    inventory: {
      encoders: ["libx264", "aac"],
      decoders: ["h264", "aac"],
      muxers: ["mp4"],
      demuxers: ["mov", "mp4"],
      filters: [],
    },

    inputPath: "/mavio-test/input.bin",
    outputPath: "/mavio-test/output.mp4",
  };
}

function values(args, flag) {
  return args.flatMap((value, index) => (value === flag ? [args[index + 1]] : []));
}

test("browser MP4 commands map selected stream indexes and both presets", () => {
  for (const preset of ["video-balanced-v1", "video-small-v1"]) {
    const options = fixture();
    options.plan.terminal.preset = preset;
    options.plan.transformations = [{ type: "convert", options: { format: "mp4", preset } }];

    const args = buildBrowserMp4Command(options);

    assert.deepEqual(values(args, "-map"), ["0:2", "0:5"]);
    assert.deepEqual(values(args, "-ar:a:0"), ["48000"]);
    assert.deepEqual(values(args, "-ac:a:0"), ["2"]);
    assert.deepEqual(values(args, "-channel_layout:a:0"), ["stereo"]);
    assert.equal(args.at(-1), options.outputPath);
    assert.equal(Object.isFrozen(args), true);
  }
});

test("video-only browser commands omit audio mapping and encoding", () => {
  const options = fixture();
  options.source.metadata.streams.pop();
  options.source.streams.pop();
  options.inventory.encoders = ["libx264"];
  options.inventory.decoders = ["h264"];

  const args = buildBrowserMp4Command(options);

  assert.deepEqual(values(args, "-map"), ["0:2"]);
  assert.ok(args.includes("-an"));
  assert.equal(args.includes("-c:a"), false);
});

test("browser MP4 rejects unsupported pixel and color profiles", () => {
  for (const [field, value] of [
    ["pixelFormat", "yuv420p10le"],
    ["colorTransfer", "smpte2084"],
    ["colorPrimaries", "bt2020"],
    ["colorSpace", undefined],
    ["colorRange", "pc"],
    ["attachedPicture", true],
  ]) {
    const options = fixture();
    options.source.streams[0][field] = value;

    assert.throws(() => buildBrowserMp4Command(options), {
      code: "UNSUPPORTED_CAPABILITY",
    });
  }
});

test("browser MP4 rejects unsupported orientation, pixels and dimensions", () => {
  for (const modify of [
    (value) => {
      value.source.streams[0].defaultOrientation = false;
    },
    (value) => {
      value.source.streams[0].sampleAspectRatio = "4:3";
    },
    (value) => {
      value.source.metadata.streams[0].width = 319;
    },
    (value) => {
      value.source.metadata.streams[0].height = 0;
    },
  ]) {
    const options = fixture();
    modify(options);

    assert.throws(() => buildBrowserMp4Command(options), {
      code: "UNSUPPORTED_CAPABILITY",
    });
  }
});

test("browser MP4 requires decoders for every selected stream", () => {
  for (const decoders of [["aac"], ["h264"]]) {
    const options = fixture();
    options.inventory.decoders = decoders;

    assert.throws(
      () => buildBrowserMp4Command(options),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
        assert.equal(error.details.reason, "MISSING_SOURCE_DECODER");
        return true;
      },
    );
  }
});

test("browser MP4 rejects pending transformations and conflicting presets", () => {
  for (const transformation of [
    { type: "extractAudio", options: {} },
    { type: "compress", options: { preset: "video-small-v1" } },
  ]) {
    const options = fixture();
    options.plan.transformations = [transformation];

    assert.throws(() => buildBrowserMp4Command(options), {
      code: "UNSUPPORTED_CAPABILITY",
    });
  }
});

test("browser MP4 paths must remain in one owned workspace", () => {
  for (const [inputPath, outputPath] of [
    ["/mavio-test/input.bin", "/mavio-test/input.bin"],
    ["/mavio-test/input.bin", "/mavio-other/output.mp4"],
    ["/mavio-test/../input.bin", "/mavio-test/output.mp4"],
    ["https://example.com/input.bin", "/mavio-test/output.mp4"],
    ["/input.bin", "/output.mp4"],
  ]) {
    assert.throws(
      () =>
        buildBrowserMp4Command({
          ...fixture(),
          inputPath,
          outputPath,
        }),
      { code: "INVALID_OPTIONS" },
    );
  }
});

test("browser MP4 commands strip metadata and avoid conflicting overwrite flags", () => {
  const options = fixture();
  const snapshot = structuredClone(options);
  const args = buildBrowserMp4Command(options);

  assert.deepEqual(values(args, "-map_metadata"), ["-1"]);
  assert.deepEqual(values(args, "-map_chapters"), ["-1"]);
  assert.deepEqual(values(args, "-protocol_whitelist"), ["file"]);
  assert.deepEqual(values(args, "-threads:v"), ["1"]);
  assert.ok(args.includes("-noautorotate"));

  assert.equal(args.includes("-n"), false);
  assert.equal(args.includes("-y"), false);
  assert.deepEqual(options, snapshot);
});

function enableTrim(options) {
  options.inventory.filters = ["trim", "settb", "setpts", "atrim", "asetpts"];
  return options;
}

test("browser MP4 trim commands preserve the requested shared time origin", () => {
  const options = enableTrim(fixture());

  options.plan.transformations = [{ type: "trim", options: { start: 0.125, end: 0.375 } }];

  const args = buildBrowserMp4Command(options);

  assert.ok(args.indexOf("-copyts") < args.indexOf("-i"));

  assert.deepEqual(values(args, "-vf"), [
    "trim=start=125000us:end=375000us,settb=expr=1/1000000,setpts=PTS-125000/(1000000*TB)",
  ]);

  assert.deepEqual(values(args, "-af"), [
    "atrim=start=125000us:end=375000us,asetpts=PTS-125000/(1000000*TB)",
  ]);

  assert.deepEqual(values(args, "-enc_time_base:v"), ["1:1000000"]);
  assert.deepEqual(values(args, "-video_track_timescale"), ["1000000"]);
  assert.deepEqual(values(args, "-avoid_negative_ts"), ["disabled"]);
});

test("consecutive browser MP4 trims produce one combined filter interval", () => {
  const options = enableTrim(fixture());
  options.source.metadata.durationSeconds = 10;

  options.plan.transformations = [
    { type: "trim", options: { start: 2, end: 8 } },
    { type: "trim", options: { start: 1, end: 3 } },
  ];

  const args = buildBrowserMp4Command(options);

  assert.equal(values(args, "-vf").length, 1);
  assert.ok(values(args, "-vf")[0].startsWith("trim=start=3000000us:end=5000000us"));
});

test("video-only browser trim commands omit audio filters", () => {
  const options = enableTrim(fixture());

  options.source.metadata.streams = options.source.metadata.streams.filter(
    (stream) => stream.kind === "video",
  );
  options.source.streams = options.source.streams.filter((stream) => stream.index === 2);
  options.inventory.filters = ["trim", "settb", "setpts"];

  options.plan.transformations = [{ type: "trim", options: { start: 0.125, end: 0.375 } }];

  const args = buildBrowserMp4Command(options);

  assert.equal(values(args, "-vf").length, 1);
  assert.deepEqual(values(args, "-af"), []);
  assert.ok(args.includes("-an"));
});

test("browser MP4 trim commands reject invalid ranges and unsupported origins", () => {
  const outOfRange = enableTrim(fixture());
  outOfRange.plan.transformations = [{ type: "trim", options: { start: 0, end: 2 } }];

  assert.throws(() => buildBrowserMp4Command(outOfRange), {
    code: "INVALID_OPTIONS",
  });

  const unsupportedOrigin = enableTrim(fixture());
  unsupportedOrigin.source.formatStartTimeSeconds = 1;
  unsupportedOrigin.plan.transformations = [{ type: "trim", options: { start: 0, end: 0.5 } }];

  assert.throws(() => buildBrowserMp4Command(unsupportedOrigin), {
    code: "UNSUPPORTED_CAPABILITY",
  });

  const unsupportedPrecision = enableTrim(fixture());
  unsupportedPrecision.plan.transformations = [{ type: "trim", options: { start: 0, end: 1 / 3 } }];

  assert.throws(() => buildBrowserMp4Command(unsupportedPrecision), {
    code: "UNSUPPORTED_CAPABILITY",
  });
});

test("browser MP4 resize commands support both presets without upscaling", () => {
  for (const preset of ["video-balanced-v1", "video-small-v1"]) {
    const options = fixture();

    options.plan.terminal.preset = preset;
    options.inventory.filters = ["scale", "setsar"];

    options.plan.transformations = [
      {
        type: "resize",
        options: { width: 160, height: 90 },
      },
      {
        type: "resize",
        options: { width: 640, height: 360 },
      },
    ];

    const args = buildBrowserMp4Command(options);

    assert.deepEqual(values(args, "-vf"), [
      "scale=w=160:h=90:flags=lanczos,setsar=1," + "scale=w=160:h=90:flags=lanczos,setsar=1",
    ]);

    assert.deepEqual(values(args, "-map"), ["0:2", "0:5"]);

    assert.deepEqual(values(args, "-fps_mode:v"), ["passthrough"]);

    assert.deepEqual(values(args, "-af"), []);
  }
});

test("browser MP4 combines consecutive trims and resizes in one video chain", () => {
  const options = enableTrim(fixture());

  options.inventory.filters.push("scale", "setsar");

  options.plan.transformations = [
    {
      type: "trim",
      options: { start: 0.125, end: 0.5 },
    },
    {
      type: "resize",
      options: { width: 160, height: 90 },
    },
    {
      type: "trim",
      options: { start: 0.125, end: 0.25 },
    },
    {
      type: "resize",
      options: { width: 640, height: 360 },
    },
  ];

  const args = buildBrowserMp4Command(options);
  const filters = values(args, "-vf");

  assert.equal(filters.length, 1);

  assert.equal(
    filters[0],
    "trim=start=250000us:end=375000us," +
      "settb=expr=1/1000000," +
      "setpts=PTS-250000/(1000000*TB)," +
      "scale=w=160:h=90:flags=lanczos,setsar=1," +
      "scale=w=160:h=90:flags=lanczos,setsar=1",
  );

  assert.deepEqual(values(args, "-af"), [
    "atrim=start=250000us:end=375000us," + "asetpts=PTS-250000/(1000000*TB)",
  ]);

  assert.deepEqual(values(args, "-enc_time_base:v"), ["1:1000000"]);
});

test("browser MP4 resize commands reject missing required filters", () => {
  for (const missing of ["scale", "setsar"]) {
    const options = fixture();

    options.inventory.filters = ["scale", "setsar"].filter((filter) => filter !== missing);

    options.plan.transformations = [
      {
        type: "resize",
        options: { width: 160, height: 90 },
      },
    ];

    assert.throws(
      () => buildBrowserMp4Command(options),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
        assert.equal(error.details.reason, "MISSING_FILTER");
        assert.equal(error.details.filter, missing);
        return true;
      },
    );
  }
});

test("browser MP4 without trim or resize adds no filter chain", () => {
  const options = fixture();
  const before = structuredClone(options);

  const args = buildBrowserMp4Command(options);

  assert.deepEqual(values(args, "-vf"), []);
  assert.deepEqual(values(args, "-af"), []);
  assert.equal(args.includes("-copyts"), false);
  assert.deepEqual(options, before);
});
