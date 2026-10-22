import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserThumbnailPlan } from "../../dist/engines/browser/thumbnail-plan.js";

function fixture() {
  return {
    source: {
      metadata: {
        container: "mov,mp4,m4a,3gp,3g2,mj2",
        durationSeconds: 8,
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
    transformations: [],
    at: 0.25,
    inventory: {
      encoders: [],
      decoders: ["h264"],
      muxers: [],
      demuxers: [],
      filters: ["trim", "setpts"],
    },
  };
}

function plan(value) {
  return buildBrowserThumbnailPlan(value.source, value.transformations, value.at, value.inventory);
}

test("browser thumbnail selects video by source order and plans a bounded frame interval", () => {
  const value = fixture();

  value.source.metadata.streams.push({
    index: 2,
    kind: "video",
    codec: "h264",
    width: 640,
    height: 360,
  });

  const result = plan(value);

  assert.deepEqual(result.source, {
    videoStreamIndex: 7,
    width: 320,
    height: 180,
  });

  assert.deepEqual(result.time, {
    sourceAtSeconds: 0.25,
    sourceEndSeconds: 8,
  });

  assert.deepEqual(result.inputArgs, ["-copyts"]);

  assert.equal(result.video, "trim=start=250000us:end=8000000us,setpts=PTS-STARTPTS");
});

test("browser thumbnail rejects unsupported source profiles", () => {
  for (const [field, replacement, reason] of [
    ["pixelFormat", "yuv420p10le", "UNSUPPORTED_PIXEL_FORMAT"],
    ["colorTransfer", "smpte2084", "UNSUPPORTED_COLOR_PROFILE"],
    ["attachedPicture", true, "UNSUPPORTED_VIDEO_DISPOSITION"],
    ["defaultOrientation", false, "UNSUPPORTED_THUMBNAIL_ORIENTATION"],
    ["sampleAspectRatio", "2:1", "UNSUPPORTED_THUMBNAIL_SAMPLE_ASPECT_RATIO"],
  ]) {
    const value = fixture();
    value.source.streams[0][field] = replacement;

    assert.throws(() => plan(value), {
      code: "UNSUPPORTED_CAPABILITY",
      details: { reason, streamIndex: 7 },
    });
  }
});

test("browser thumbnail requires source details, valid dimensions and a decoder", () => {
  const decoder = fixture();
  decoder.inventory.decoders = [];

  assert.throws(() => plan(decoder), {
    code: "UNSUPPORTED_CAPABILITY",
    details: {
      reason: "MISSING_SOURCE_DECODER",
      streamIndex: 7,
    },
  });

  const details = fixture();
  details.source.streams = [];

  assert.throws(() => plan(details), {
    code: "UNSUPPORTED_CAPABILITY",
    details: {
      reason: "MISSING_STREAM_DETAILS",
      streamIndex: 7,
    },
  });

  const dimensions = fixture();
  dimensions.source.metadata.streams[0].width = 0;

  assert.throws(() => plan(dimensions), {
    code: "INVALID_MEDIA",
    details: {
      reason: "INVALID_SOURCE_DIMENSIONS",
      streamIndex: 7,
    },
  });

  const missing = fixture();
  missing.source.metadata.streams = [];

  assert.throws(() => plan(missing), {
    code: "INVALID_MEDIA",
    details: { reason: "MISSING_VIDEO" },
  });
});

test("browser thumbnail time follows consecutive trims while resize leaves timing unchanged", () => {
  const value = fixture();

  value.transformations = [
    { type: "trim", options: { start: 1, end: 5 } },
    { type: "resize", options: { width: 160, height: 90 } },
    { type: "trim", options: { start: 0.5, end: 2.5 } },
  ];

  const result = plan(value);

  assert.deepEqual(result.time, {
    sourceAtSeconds: 1.75,
    sourceEndSeconds: 3.5,
  });

  assert.equal(result.video, "trim=start=1750000us:end=3500000us,setpts=PTS-STARTPTS");
});

test("browser thumbnail rejects invalid times, end boundaries and unknown duration", () => {
  for (const at of [-1, NaN, Infinity]) {
    const value = fixture();
    value.at = at;

    assert.throws(() => plan(value), {
      code: "INVALID_OPTIONS",
      details: { reason: "INVALID_THUMBNAIL_TIME" },
    });
  }

  const boundary = fixture();
  boundary.at = 8;

  assert.throws(() => plan(boundary), {
    code: "INVALID_OPTIONS",
    details: { reason: "OUT_OF_RANGE" },
  });

  const duration = fixture();
  delete duration.source.metadata.durationSeconds;

  assert.throws(() => plan(duration), {
    code: "INVALID_MEDIA",
    details: { reason: "UNKNOWN_DURATION" },
  });
});

test("browser thumbnail requires supported timing origin and microsecond precision", () => {
  for (const origin of [undefined, -1, 1]) {
    const value = fixture();
    value.source.formatStartTimeSeconds = origin;

    assert.throws(() => plan(value), {
      code: "UNSUPPORTED_CAPABILITY",
      details: { reason: "UNSUPPORTED_TIME_ORIGIN" },
    });
  }

  const precision = fixture();
  precision.at = 1 / 3;

  assert.throws(() => plan(precision), {
    code: "UNSUPPORTED_CAPABILITY",
    details: { reason: "UNSUPPORTED_THUMBNAIL_PRECISION" },
  });
});

test("browser thumbnail requires both selection filters", () => {
  for (const missing of ["trim", "setpts"]) {
    const value = fixture();

    value.inventory.filters = ["trim", "setpts"].filter((name) => name !== missing);

    assert.throws(() => plan(value), {
      code: "UNSUPPORTED_CAPABILITY",
      details: {
        reason: "MISSING_FILTER",
        filter: missing,
      },
    });
  }
});

test("browser thumbnail plans are immutable and reject unrelated transformations", () => {
  const value = fixture();
  const before = structuredClone(value);
  const result = plan(value);

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.source), true);
  assert.equal(Object.isFrozen(result.time), true);
  assert.equal(Object.isFrozen(result.inputArgs), true);
  assert.deepEqual(value, before);

  value.transformations = [
    {
      type: "compress",
      options: { preset: "video-balanced-v1" },
    },
  ];

  assert.throws(() => plan(value), {
    code: "INVALID_OPTIONS",
    details: { reason: "INVALID_THUMBNAIL_TRANSFORMATION" },
  });
});
