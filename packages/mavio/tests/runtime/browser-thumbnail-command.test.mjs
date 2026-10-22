import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserThumbnailCommand } from "../../dist/engines/browser/thumbnail-command.js";

function fixture(preset = "jpeg-balanced-v1") {
  const format = preset === "jpeg-balanced-v1" ? "jpeg" : "png";

  return {
    inputPath: "/mavio-thumbnail-test/input.bin",
    outputPath: `/mavio-thumbnail-test/output.${format}`,

    plan: {
      input: { kind: "bytes", bytes: new Uint8Array([1]) },
      transformations: [],
      terminal: {
        type: "thumbnail",
        at: 0.125,
        format,
        preset,
      },
      output: { kind: "bytes" },
    },

    source: {
      metadata: {
        container: "mov,mp4,m4a,3gp,3g2,mj2",
        durationSeconds: 2,
        streams: [
          {
            index: 7,
            kind: "video",
            codec: "h264",
            width: 320,
            height: 180,
          },
        ],
      },
      formatStartTimeSeconds: 0,
      streams: [
        {
          index: 7,
          pixelFormat: "yuv420p",
          colorTransfer: "bt709",
          colorPrimaries: "bt709",
          colorSpace: "bt709",
          colorRange: "tv",
          attachedPicture: false,
          defaultOrientation: true,
          sampleAspectRatio: "1:1",
        },
      ],
    },

    inventory: {
      encoders: ["mjpeg", "png"],
      decoders: ["h264"],
      muxers: ["image2pipe"],
      demuxers: ["mov"],
      filters: ["trim", "setpts", "scale", "format", "setsar"],
    },
  };
}

function values(args, flag) {
  return args.flatMap((value, index) => (value === flag ? [args[index + 1]] : []));
}

test("browser thumbnail commands select one frame from the intended video stream", () => {
  for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
    const value = fixture(preset);
    const args = buildBrowserThumbnailCommand(value);

    assert.deepEqual(values(args, "-map"), ["0:7"]);
    assert.deepEqual(values(args, "-frames:v"), ["1"]);
    assert.deepEqual(values(args, "-f"), ["image2pipe"]);
    assert.deepEqual(values(args, "-threads:v"), ["1"]);
    assert.deepEqual(values(args, "-filter_threads"), ["1"]);

    assert.deepEqual(values(args, "-c:v"), [preset === "jpeg-balanced-v1" ? "mjpeg" : "png"]);

    assert.equal(args.at(-1), value.outputPath);
    assert.equal(args.indexOf("-copyts") < args.indexOf("-i"), true);

    const filter = values(args, "-vf")[0];

    assert.ok(filter.startsWith("trim=start=125000us:end=2000000us,setpts=PTS-STARTPTS,"));

    assert.ok(filter.includes(preset === "jpeg-balanced-v1" ? "format=yuvj420p" : "format=rgb24"));
  }
});

test("browser thumbnail commands resolve trim-relative selection time", () => {
  const value = fixture();

  value.plan.transformations = [
    { type: "trim", options: { start: 0.25, end: 1.75 } },
    { type: "trim", options: { start: 0.25, end: 0.75 } },
  ];

  const args = buildBrowserThumbnailCommand(value);

  assert.ok(
    values(args, "-vf")[0].startsWith("trim=start=625000us:end=1000000us,setpts=PTS-STARTPTS,"),
  );

  assert.equal(args.includes("-ss"), false);
});

test("browser thumbnail resizes remain sequential without upscaling", () => {
  for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
    const value = fixture(preset);

    value.plan.transformations = [
      { type: "resize", options: { width: 159, height: 89 } },
      { type: "resize", options: { width: 640, height: 360 } },
    ];

    const filter = values(buildBrowserThumbnailCommand(value), "-vf")[0];
    const height = preset === "jpeg-balanced-v1" ? 88 : 89;
    const step = `scale=w=158:h=${height}:flags=lanczos,setsar=1`;

    assert.ok(filter.endsWith(`${step},${step}`));
  }
});

test("browser thumbnail commands reject unsafe or mismatched private paths", () => {
  for (const [inputPath, outputPath] of [
    ["/outside/input.bin", "/outside/output.jpeg"],
    ["/mavio-thumbnail-test/input.bin", "/mavio-other/output.jpeg"],
    ["/mavio-thumbnail-test/input.bin", "/mavio-thumbnail-test/input.bin"],
    ["/mavio-thumbnail-test/input.bin", "/mavio-thumbnail-test/output.png"],
    ["/mavio-thumbnail-test/../input.bin", "/mavio-thumbnail-test/output.jpeg"],
  ]) {
    assert.throws(
      () =>
        buildBrowserThumbnailCommand({
          ...fixture(),
          inputPath,
          outputPath,
        }),
      {
        code: "INVALID_OPTIONS",
        details: { reason: "INVALID_BROWSER_COMMAND_PATH" },
      },
    );
  }
});

test("browser thumbnail commands validate terminal format and supported IO", () => {
  const format = fixture();
  format.plan.terminal.format = "png";

  assert.throws(() => buildBrowserThumbnailCommand(format), {
    code: "INVALID_OPTIONS",
    details: { reason: "TERMINAL_FORMAT_MISMATCH" },
  });

  const input = fixture();
  input.plan.input = { kind: "path", path: "source.mp4" };

  assert.throws(() => buildBrowserThumbnailCommand(input), {
    code: "UNSUPPORTED_CAPABILITY",
    details: { reason: "UNSUPPORTED_BROWSER_IO" },
  });

  const output = fixture();
  output.plan.output = { kind: "path", path: "image.jpeg" };

  assert.throws(() => buildBrowserThumbnailCommand(output), {
    code: "UNSUPPORTED_CAPABILITY",
    details: { reason: "UNSUPPORTED_BROWSER_IO" },
  });
});

test("browser thumbnail commands reject unrelated pipeline operations", () => {
  const value = fixture();

  value.plan.transformations = [{ type: "extractAudio", options: {} }];

  assert.throws(() => buildBrowserThumbnailCommand(value), {
    code: "INVALID_OPTIONS",
    details: { reason: "INVALID_THUMBNAIL_TRANSFORMATION" },
  });
});

test("browser thumbnail commands require conversion and requested resize filters", () => {
  for (const missing of ["scale", "format", "setsar"]) {
    const value = fixture();

    if (missing === "setsar") {
      value.plan.transformations = [{ type: "resize", options: { width: 160, height: 90 } }];
    }

    value.inventory.filters = value.inventory.filters.filter((name) => name !== missing);

    assert.throws(() => buildBrowserThumbnailCommand(value), {
      code: "UNSUPPORTED_CAPABILITY",
      details: { reason: "MISSING_FILTER", filter: missing },
    });
  }
});

test("browser thumbnail commands preserve inputs and avoid overwrite conflicts", () => {
  const value = fixture();
  const before = structuredClone(value);
  const args = buildBrowserThumbnailCommand(value);

  assert.equal(Object.isFrozen(args), true);
  assert.deepEqual(value, before);

  for (const flag of ["-n", "-y", "-ss", "-t", "-af"]) {
    assert.equal(args.includes(flag), false);
  }

  for (const flag of ["-an", "-sn", "-dn", "-noautorotate"]) {
    assert.equal(args.includes(flag), true);
  }

  for (const flag of ["-map_metadata", "-map_metadata:s", "-map_chapters"]) {
    assert.deepEqual(values(args, flag), ["-1"]);
  }
});
