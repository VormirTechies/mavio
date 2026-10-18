import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { buildNativeMp4Command } from "../../dist/engines/native/mp4-command.js";
import { parseNativeProbeDetails } from "../../dist/engines/native/probe-details.js";

function options({ withAudio = true } = {}) {
  return {
    inputPath: resolve("source with spaces & symbols.mp4"),
    outputPath: resolve("private output.mp4"),
    inventory: {
      encoders: ["libx264", ...(withAudio ? ["aac"] : [])],
      decoders: [],
      muxers: ["mp4"],
      demuxers: [],
      filters: [],
    },
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
    source: parseNativeProbeDetails(
      JSON.stringify({
        streams: [
          {
            index: 3,
            codec_type: "video",
            width: 320,
            height: 180,
            pix_fmt: "yuv420p",
            color_transfer: "bt709",
            color_primaries: "bt709",
            color_space: "bt709",
            color_range: "tv",
            disposition: { attached_pic: 0 },
          },
          ...(withAudio
            ? [
                {
                  index: 7,
                  codec_type: "audio",
                  sample_rate: "48000",
                  channels: 2,
                  channel_layout: "stereo",
                },
              ]
            : []),
        ],
      }),
    ),
  };
}

function values(args, flag) {
  return args.flatMap((value, index) => (value === flag ? [args[index + 1]] : []));
}

test("MP4 command maps absolute stream indexes and preserves selected audio settings", () => {
  const input = options();
  const before = structuredClone(input);
  const args = buildNativeMp4Command(input);

  assert.deepEqual(values(args, "-map"), ["0:3", "0:7"]);
  assert.deepEqual(values(args, "-ar:a:0"), ["48000"]);
  assert.deepEqual(values(args, "-ac:a:0"), ["2"]);
  assert.deepEqual(values(args, "-channel_layout:a:0"), ["stereo"]);
  assert.deepEqual(values(args, "-pix_fmt"), ["+yuv420p"]);
  assert.deepEqual(values(args, "-i"), [input.inputPath]);
  assert.equal(args.at(-1), input.outputPath);
  assert.deepEqual(input, before);
  assert.ok(Object.isFrozen(args));

  assert.deepEqual(values(args, "-map_metadata"), ["-1"]);
  assert.deepEqual(values(args, "-map_metadata:s"), ["-1"]);
  assert.deepEqual(values(args, "-map_chapters"), ["-1"]);
  assert.ok(args.includes("-n"));

  for (const forbidden of ["-y", "-shortest", "-r", "-ss", "-t", "-vf"]) {
    assert.equal(args.includes(forbidden), false);
  }
});

test("video-only MP4 commands do not require AAC or introduce audio", () => {
  const args = buildNativeMp4Command(options({ withAudio: false }));

  assert.deepEqual(values(args, "-map"), ["0:3"]);
  assert.ok(args.includes("-an"));
  assert.equal(args.includes("-c:a"), false);
  assert.equal(args.includes("-ar:a:0"), false);
  assert.equal(args.includes("-ac:a:0"), false);
});

test("MP4 command construction rejects unsupported plans instead of omitting operations", () => {
  for (const transformation of [{ type: "extractAudio", options: {} }]) {
    const input = options();
    input.plan.transformations = [transformation];

    assert.throws(
      () => buildNativeMp4Command(input),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
        assert.equal(error.operation, transformation.type);
        assert.equal(error.details.reason, "NATIVE_TRANSFORMATION_PENDING");
        assert.equal(error.details.operationIndex, 0);
        return true;
      },
    );
  }

  const input = options();
  input.plan.terminal.preset = "audio-balanced-v1";

  assert.throws(() => buildNativeMp4Command(input), { code: "UNSUPPORTED_CAPABILITY" });
});

test("MP4 command construction rejects unsafe path choices and unsupported source dimensions", () => {
  for (const path of ["relative.mp4", ""]) {
    const input = options();
    input.outputPath = path;

    assert.throws(() => buildNativeMp4Command(input), { code: "INVALID_OPTIONS" });
  }

  const samePath = options();
  samePath.outputPath = samePath.inputPath;

  assert.throws(() => buildNativeMp4Command(samePath), { code: "INVALID_OPTIONS" });

  for (const width of [undefined, 0, 321]) {
    const input = options();
    input.source.metadata.streams[0].width = width;

    assert.throws(
      () => buildNativeMp4Command(input),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
        assert.equal(error.details.reason, "UNSUPPORTED_VIDEO_DIMENSIONS");
        return true;
      },
    );
  }
});

function trimOptions({ withAudio = true } = {}) {
  const input = options({ withAudio });

  input.inventory.filters = ["trim", "settb", "setpts", "atrim", "asetpts"];

  input.source = {
    ...input.source,
    formatStartTimeSeconds: 0,
    metadata: {
      ...input.source.metadata,
      durationSeconds: 2,
    },
  };

  input.plan.transformations = [{ type: "trim", options: { start: 0.51, end: 1.49 } }];

  return input;
}

test("MP4 trim command preserves the requested origin and uses precise timing", () => {
  const input = trimOptions();
  const before = structuredClone(input);
  const args = buildNativeMp4Command(input);

  assert.deepEqual(values(args, "-map"), ["0:3", "0:7"]);
  assert.deepEqual(values(args, "-vf"), [
    "trim=start=510000us:end=1490000us,settb=expr=1/1000000,setpts=PTS-510000/(1000000*TB)",
  ]);
  assert.deepEqual(values(args, "-af"), [
    "atrim=start=510000us:end=1490000us,asetpts=PTS-510000/(1000000*TB)",
  ]);

  assert.ok(args.indexOf("-copyts") < args.indexOf("-i"));
  assert.deepEqual(values(args, "-enc_time_base:v"), ["filter"]);
  assert.deepEqual(values(args, "-video_track_timescale"), ["1000000"]);
  assert.deepEqual(values(args, "-movie_timescale"), ["1000000"]);
  assert.deepEqual(values(args, "-avoid_negative_ts"), ["disabled"]);
  assert.deepEqual(values(args, "-use_editlist"), ["1"]);

  assert.ok(args.includes("-xerror"));
  assert.equal(args.filter((arg) => arg === input.outputPath).length, 1);
  assert.equal(args.at(-1), input.outputPath);
  assert.deepEqual(input, before);

  for (const forbidden of ["-ss", "-t", "-shortest", "-r"]) {
    assert.equal(args.includes(forbidden), false);
  }
});

test("MP4 command combines consecutive trims into one filter chain", () => {
  const input = trimOptions();

  input.source.metadata.durationSeconds = 10;
  input.plan.transformations = [
    { type: "trim", options: { start: 2, end: 8 } },
    { type: "compress", options: { preset: "video-balanced-v1" } },
    { type: "trim", options: { start: 1, end: 3 } },
  ];

  const args = buildNativeMp4Command(input);

  assert.deepEqual(values(args, "-vf"), [
    "trim=start=3000000us:end=5000000us,settb=expr=1/1000000,setpts=PTS-3000000/(1000000*TB)",
  ]);
  assert.deepEqual(values(args, "-af"), [
    "atrim=start=3000000us:end=5000000us,asetpts=PTS-3000000/(1000000*TB)",
  ]);
});

test("video-only trim commands omit audio filters and settings", () => {
  const input = trimOptions({ withAudio: false });
  input.inventory.filters = ["trim", "settb", "setpts"];

  const args = buildNativeMp4Command(input);

  assert.equal(values(args, "-vf").length, 1);
  assert.deepEqual(values(args, "-af"), []);
  assert.deepEqual(values(args, "-map"), ["0:3"]);
  assert.ok(args.includes("-an"));
  assert.equal(args.includes("-c:a"), false);
});

test("MP4 trim command rejects unknown timing and out-of-range requests", () => {
  const unknownDuration = trimOptions();
  unknownDuration.source.metadata.durationSeconds = undefined;

  assert.throws(
    () => buildNativeMp4Command(unknownDuration),
    (error) => {
      assert.equal(error.code, "INVALID_MEDIA");
      assert.equal(error.details.reason, "UNKNOWN_DURATION");
      return true;
    },
  );

  const unknownOrigin = trimOptions();
  unknownOrigin.source = {
    ...unknownOrigin.source,
    formatStartTimeSeconds: undefined,
  };

  assert.throws(
    () => buildNativeMp4Command(unknownOrigin),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
      assert.equal(error.details.reason, "UNSUPPORTED_TIME_ORIGIN");
      return true;
    },
  );

  const outside = trimOptions();
  outside.plan.transformations = [{ type: "trim", options: { start: 0, end: 3 } }];

  assert.throws(
    () => buildNativeMp4Command(outside),
    (error) => {
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.details.reason, "OUT_OF_RANGE");
      return true;
    },
  );
});

function enableResize(input) {
  input.inventory.filters.push("scale", "setsar");
  input.source = {
    ...input.source,
    streams: input.source.streams.map((stream) =>
      stream.index === 3
        ? {
            ...stream,
            sampleAspectRatio: "1:1",
            defaultOrientation: true,
          }
        : stream,
    ),
  };
}

test("MP4 command combines trim and resize into one video filter chain", () => {
  const input = trimOptions();
  enableResize(input);
  input.plan.transformations.push({
    type: "resize",
    options: { width: 160, height: 90 },
  });

  const args = buildNativeMp4Command(input);

  assert.deepEqual(values(args, "-vf"), [
    "trim=start=510000us:end=1490000us,settb=expr=1/1000000,setpts=PTS-510000/(1000000*TB),scale=w=160:h=90:flags=lanczos,setsar=1",
  ]);
  assert.equal(values(args, "-af").length, 1);
  assert.equal(args.filter((arg) => arg === input.outputPath).length, 1);
});

test("MP4 command retains consecutive resize steps and aligned dimensions", () => {
  const input = options();
  enableResize(input);
  input.plan.transformations = [
    { type: "resize", options: { width: 101, height: 101 } },
    { type: "resize", options: { width: 80, height: 80 } },
  ];

  const args = buildNativeMp4Command(input);

  assert.deepEqual(values(args, "-vf"), [
    "scale=w=100:h=56:flags=lanczos,setsar=1,scale=w=80:h=44:flags=lanczos,setsar=1",
  ]);
  assert.equal(args.includes("-copyts"), false);
  assert.equal(args.includes("-af"), false);
});

test("MP4 resize command rejects unsupported source geometry", () => {
  const input = options();
  enableResize(input);
  input.plan.transformations = [{ type: "resize", options: { width: 160, height: 90 } }];
  input.source = {
    ...input.source,
    streams: input.source.streams.map((stream) =>
      stream.index === 3 ? { ...stream, sampleAspectRatio: "4:3" } : stream,
    ),
  };

  assert.throws(
    () => buildNativeMp4Command(input),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
      assert.equal(error.details.reason, "UNSUPPORTED_RESIZE_SAMPLE_ASPECT_RATIO");
      return true;
    },
  );
});

test("small MP4 commands select the approved settings without implicit resizing", () => {
  const input = options();
  input.plan.terminal.preset = "video-small-v1";
  input.plan.transformations = [{ type: "compress", options: { preset: "video-small-v1" } }];

  const args = buildNativeMp4Command(input);

  assert.deepEqual(values(args, "-crf"), ["28"]);
  assert.deepEqual(values(args, "-b:a"), ["96k"]);
  assert.deepEqual(values(args, "-preset"), ["veryfast"]);
  assert.deepEqual(values(args, "-map"), ["0:3", "0:7"]);
  assert.equal(args.includes("-vf"), false);
  assert.equal(args.includes("-r"), false);
  assert.equal(args.at(-1), input.outputPath);
});

test("small video-only commands omit audio encoding", () => {
  const input = options({ withAudio: false });
  input.plan.terminal.preset = "video-small-v1";

  const args = buildNativeMp4Command(input);

  assert.deepEqual(values(args, "-crf"), ["28"]);
  assert.ok(args.includes("-an"));
  assert.equal(args.includes("-c:a"), false);
  assert.equal(args.includes("-b:a"), false);
});

test("MP4 commands reject conflicting transformation and terminal presets", () => {
  for (const [terminalPreset, transformationPreset] of [
    ["video-small-v1", "video-balanced-v1"],
    ["video-balanced-v1", "video-small-v1"],
  ]) {
    for (const type of ["compress", "convert"]) {
      const input = options();
      input.plan.terminal.preset = terminalPreset;
      input.plan.transformations = [
        {
          type,
          options: {
            preset: transformationPreset,
            ...(type === "convert" ? { format: "mp4" } : {}),
          },
        },
      ];

      assert.throws(() => buildNativeMp4Command(input), { code: "UNSUPPORTED_CAPABILITY" });
    }
  }
});

test("small preset source failures identify the selected preset", () => {
  const input = options();
  input.plan.terminal.preset = "video-small-v1";
  input.source = {
    ...input.source,
    streams: input.source.streams.map((stream) =>
      stream.index === 3 ? { ...stream, pixelFormat: "yuv420p10le" } : stream,
    ),
  };

  assert.throws(
    () => buildNativeMp4Command(input),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
      assert.equal(error.details.reason, "UNSUPPORTED_PIXEL_FORMAT");
      assert.equal(error.details.preset, "video-small-v1");
      return true;
    },
  );
});
