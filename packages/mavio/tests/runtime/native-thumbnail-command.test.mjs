import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { buildNativeThumbnailCommand } from "../../dist/engines/native/thumbnail-command.js";

function options(preset = "jpeg-balanced-v1") {
  return {
    inputPath: resolve("source with spaces.mp4"),
    outputPath: resolve("private image.bin"),
    inventory: {
      encoders: ["mjpeg", "png"],
      decoders: [],
      muxers: ["image2pipe"],
      demuxers: [],
      filters: ["trim", "setpts", "scale", "format"],
    },
    plan: {
      input: { kind: "path", path: resolve("source with spaces.mp4") },
      transformations: [],
      terminal: {
        type: "thumbnail",
        at: 0.5,
        format: preset === "jpeg-balanced-v1" ? "jpeg" : "png",
        preset,
      },
      output: { kind: "bytes" },
    },
    source: {
      formatStartTimeSeconds: 0,
      metadata: {
        durationSeconds: 2,
        streams: [
          { index: 3, kind: "video", width: 320, height: 180 },
          { index: 7, kind: "audio" },
        ],
      },
      streams: [
        {
          index: 3,
          attachedPicture: false,
          pixelFormat: "yuv420p",
          colorTransfer: "bt709",
          colorPrimaries: "bt709",
          colorSpace: "bt709",
          colorRange: "tv",
          defaultOrientation: true,
          sampleAspectRatio: "1:1",
        },
      ],
    },
  };
}

function values(args, flag) {
  return args.flatMap((value, index) => (value === flag ? [args[index + 1]] : []));
}

test("thumbnail commands map one video stream and encode one image", () => {
  for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
    const input = options(preset);
    const before = structuredClone(input);
    const args = buildNativeThumbnailCommand(input);
    const jpeg = preset === "jpeg-balanced-v1";

    assert.deepEqual(values(args, "-map"), ["0:3"]);
    assert.deepEqual(values(args, "-frames:v"), ["1"]);
    assert.deepEqual(values(args, "-c:v"), [jpeg ? "mjpeg" : "png"]);
    assert.deepEqual(values(args, "-pix_fmt"), [jpeg ? "yuvj420p" : "rgb24"]);
    assert.deepEqual(values(args, "-f"), ["image2pipe"]);
    assert.deepEqual(values(args, "-i"), [input.inputPath]);
    assert.equal(args.at(-1), input.outputPath);
    assert.equal(Object.isFrozen(args), true);
    assert.deepEqual(input, before);

    const filter = values(args, "-vf")[0];
    assert.ok(filter.startsWith("trim=start=500000us:end=2000000us,setpts=PTS-STARTPTS,"));
    assert.ok(filter.includes("in_color_matrix=bt709"));
    assert.ok(filter.includes("in_range=tv:out_range=pc"));

    if (jpeg) assert.ok(filter.includes("out_color_matrix=bt601"));

    for (const flag of ["-n", "-an", "-sn", "-dn", "-noautorotate"]) {
      assert.equal(args.includes(flag), true);
    }
    for (const flag of ["-y", "-ss", "-t", "-c:a"]) {
      assert.equal(args.includes(flag), false);
    }
  }
});

test("thumbnail command resolves time within consecutive trims", () => {
  const input = options();
  input.source.metadata.durationSeconds = 8;
  input.plan.transformations = [
    { type: "trim", options: { start: 1, end: 5 } },
    { type: "trim", options: { start: 0.5, end: 2.5 } },
  ];
  input.plan.terminal.at = 0.25;

  const args = buildNativeThumbnailCommand(input);

  assert.ok(
    values(args, "-vf")[0].startsWith("trim=start=1750000us:end=3500000us,setpts=PTS-STARTPTS,"),
  );
});

test("thumbnail command rejects format and preset mismatches", () => {
  const input = options();
  input.plan.terminal.format = "png";

  assert.throws(() => buildNativeThumbnailCommand(input), {
    code: "INVALID_OPTIONS",
    details: { reason: "TERMINAL_FORMAT_MISMATCH" },
  });
});

test("thumbnail resize uses preset alignment and never upscales a preceding result", () => {
  for (const [preset, width, height] of [
    ["jpeg-balanced-v1", 158, 88],
    ["png-lossless-v1", 159, 89],
  ]) {
    const input = options(preset);
    input.inventory.filters.push("setsar");
    input.plan.transformations = [
      { type: "resize", options: { width: 159, height: 99 } },
      { type: "resize", options: { width: 320, height: 180 } },
    ];

    const filter = values(buildNativeThumbnailCommand(input), "-vf")[0];

    assert.ok(
      filter.endsWith(
        `scale=w=${width}:h=${height}:flags=lanczos,setsar=1,` +
          `scale=w=${width}:h=${height}:flags=lanczos,setsar=1`,
      ),
    );
  }
});

test("thumbnail resize rejects missing square-pixel conversion and collapsed dimensions", () => {
  const input = options();
  input.plan.transformations = [{ type: "resize", options: { width: 160, height: 90 } }];

  assert.throws(() => buildNativeThumbnailCommand(input), {
    code: "UNSUPPORTED_CAPABILITY",
    details: { reason: "MISSING_FILTER", filter: "setsar" },
  });

  input.inventory.filters.push("setsar");
  input.plan.transformations = [{ type: "resize", options: { width: 1, height: 1 } }];

  assert.throws(() => buildNativeThumbnailCommand(input), {
    code: "INVALID_OPTIONS",
    details: { reason: "INVALID_DIMENSIONS", operationIndex: 0 },
  });
});

test("thumbnail command rejects incompatible composition", () => {
  const input = options();
  input.plan.transformations = [{ type: "compress", options: { preset: "video-balanced-v1" } }];

  assert.throws(() => buildNativeThumbnailCommand(input), {
    code: "INVALID_OPTIONS",
    details: { reason: "INVALID_THUMBNAIL_TRANSFORMATION" },
  });
});

test("thumbnail command requires distinct fully qualified paths", () => {
  for (const field of ["inputPath", "outputPath"]) {
    const input = options();
    input[field] = "relative.bin";

    assert.throws(() => buildNativeThumbnailCommand(input), {
      code: "INVALID_OPTIONS",
      details: { reason: "INVALID_NATIVE_COMMAND_PATH" },
    });
  }

  const input = options();
  input.outputPath = input.inputPath;

  assert.throws(() => buildNativeThumbnailCommand(input), {
    code: "INVALID_OPTIONS",
    details: { reason: "INPUT_OUTPUT_PATH_CONFLICT" },
  });
});

test("thumbnail command requires conversion filters and supported source colors", () => {
  for (const missing of ["scale", "format"]) {
    const input = options();
    input.inventory.filters = input.inventory.filters.filter((filter) => filter !== missing);

    assert.throws(() => buildNativeThumbnailCommand(input), {
      code: "UNSUPPORTED_CAPABILITY",
      details: { reason: "MISSING_FILTER", filter: missing },
    });
  }

  const input = options();
  input.source.streams[0].colorTransfer = "smpte2084";

  assert.throws(() => buildNativeThumbnailCommand(input), {
    code: "UNSUPPORTED_CAPABILITY",
    details: { reason: "UNSUPPORTED_COLOR_PROFILE", streamIndex: 3 },
  });
});
