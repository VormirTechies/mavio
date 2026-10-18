import assert from "node:assert/strict";
import test from "node:test";
import { captureMetadata } from "../../dist/core/adapter-response.js";
import { parseNativeProbeMetadata } from "../../dist/engines/native/probe-metadata.js";

function parse(value) {
  return parseNativeProbeMetadata(JSON.stringify(value), "probe-test");
}

test("probe metadata maps format, video, and audio fields to the public contract", () => {
  const result = parse({
    format: {
      duration: "6.250000",
      size: "4096",
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
      bit_rate: "5242",
    },
    streams: [
      {
        index: 0,
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
        avg_frame_rate: "30000/1001",
      },
      {
        index: 2,
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
        channels: 2,
      },
    ],
  });

  assert.deepEqual(result, {
    durationSeconds: 6.25,
    sizeBytes: 4096,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    bitrateBitsPerSecond: 5242,
    streams: [
      {
        index: 0,
        kind: "video",
        codec: "h264",
        width: 1920,
        height: 1080,
        frameRate: { numerator: 30000, denominator: 1001 },
      },
      {
        index: 2,
        kind: "audio",
        codec: "aac",
        sampleRate: 48000,
        channels: 2,
      },
    ],
  });

  assert.deepEqual(captureMetadata(result), result);
});

test("unavailable and invalid optional numbers remain unknown", () => {
  for (const value of [
    "N/A",
    "",
    " ",
    null,
    true,
    {},
    [],
    "Infinity",
    "NaN",
    "0x10",
    "12seconds",
    "-1",
    "1e999",
  ]) {
    const result = parse({
      format: { duration: value, size: value, bit_rate: value },
      streams: [],
    });

    assert.equal(result.durationSeconds, undefined);
    assert.equal(result.sizeBytes, undefined);
    assert.equal(result.bitrateBitsPerSecond, undefined);
  }

  const result = parse({
    format: { size: "9007199254740992" },
    streams: [{ index: 0, codec_type: "audio", channels: 1.5 }],
  });

  assert.equal(result.sizeBytes, undefined);
  assert.equal(result.streams[0].channels, undefined);
});

test("zero duration and size are retained while zero dimensions remain unknown", () => {
  const result = parse({
    format: { duration: "0", size: "0", bit_rate: "0" },
    streams: [
      { index: 0, codec_type: "video", width: 0, height: 0 },
      { index: 1, codec_type: "audio", sample_rate: "0", channels: 0 },
    ],
  });

  assert.equal(result.durationSeconds, 0);
  assert.equal(result.sizeBytes, 0);
  assert.equal(result.bitrateBitsPerSecond, 0);
  assert.equal(result.streams[0].width, undefined);
  assert.equal(result.streams[0].height, undefined);
  assert.equal(result.streams[1].sampleRate, undefined);
  assert.equal(result.streams[1].channels, undefined);
});

test("unknown average frame rates do not fall back to nominal frame rates", () => {
  for (const rate of [
    undefined,
    "N/A",
    "0/0",
    "0/1",
    "24/0",
    "-24/1",
    "24",
    "24/1extra",
    "9007199254740992/1",
  ]) {
    const result = parse({
      streams: [
        {
          index: 0,
          codec_type: "video",
          avg_frame_rate: rate,
          r_frame_rate: "60/1",
        },
      ],
    });

    assert.equal(result.streams[0].frameRate, undefined);
  }
});

test("subtitle and unknown stream types retain their original indexes", () => {
  const result = parse({
    streams: [
      { index: 7, codec_type: "subtitle", codec_name: "subrip" },
      { index: 3, codec_type: "attachment", codec_name: "ttf" },
      { index: 9, codec_type: "future_type" },
    ],
  });

  assert.deepEqual(
    result.streams.map(({ index, kind }) => ({ index, kind })),
    [
      { index: 7, kind: "subtitle" },
      { index: 3, kind: "other" },
      { index: 9, kind: "other" },
    ],
  );

  assert.equal(result.durationSeconds, undefined);
  assert.deepEqual(parse({ streams: [] }).streams, []);
});

test("malformed JSON and invalid response structures fail with bounded diagnostics", () => {
  const cases = [
    ["private broken JSON", "$"],
    ["null", "$"],
    ["[]", "$"],
    ["{}", "$.streams"],
    [JSON.stringify({ streams: {} }), "$.streams"],
    [JSON.stringify({ streams: [null] }), "$.streams[0]"],
    [JSON.stringify({ streams: [], format: [] }), "$.format"],
    [JSON.stringify({ streams: [], error: { message: "private detail" } }), "$.error"],
  ];

  for (const [text, field] of cases) {
    assert.throws(
      () => parseNativeProbeMetadata(text, "probe-test"),
      (error) => {
        assert.equal(error.code, "EXECUTION_FAILED");
        assert.equal(error.stage, "preparing");
        assert.equal(error.jobId, "probe-test");
        assert.deepEqual(error.details, {
          reason: "INVALID_PROBE_RESPONSE",
          tool: "ffprobe",
          field,
        });
        assert.equal(error.message.includes("private"), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});

test("missing, invalid, and duplicate stream indexes are rejected", () => {
  for (const index of [undefined, "0", -1, 0.5, 9007199254740992]) {
    assert.throws(() => parse({ streams: [{ index, codec_type: "video" }] }), {
      code: "EXECUTION_FAILED",
      details: {
        reason: "INVALID_PROBE_RESPONSE",
        tool: "ffprobe",
        field: "$.streams[0].index",
      },
    });
  }

  assert.throws(
    () =>
      parse({
        streams: [
          { index: 0, codec_type: "video" },
          { index: 0, codec_type: "audio" },
        ],
      }),
    {
      code: "EXECUTION_FAILED",
      details: {
        reason: "INVALID_PROBE_RESPONSE",
        tool: "ffprobe",
        field: "$.streams[1].index",
      },
    },
  );
});

test("metadata excludes private tags and does not infer container duration", () => {
  const input = {
    format: {
      filename: "private-source.mp4",
      tags: { title: "private title" },
    },
    streams: [
      {
        index: 0,
        codec_type: "video",
        duration: "99",
        tags: { comment: "private comment" },
        sample_rate: "48000",
      },
    ],
  };

  const first = parse(input);
  first.streams[0].codec = "changed";

  const second = parse(input);

  assert.equal(second.streams[0].codec, undefined);
  assert.equal(second.durationSeconds, undefined);
  assert.equal(second.streams[0].sampleRate, undefined);
  assert.equal(JSON.stringify(second).includes("private"), false);
});

function rotatedVideo(fields = {}) {
  return parse({
    streams: [
      {
        index: 0,
        codec_type: "video",
        width: 1920,
        height: 1080,
        ...fields,
      },
    ],
  }).streams[0];
}

test("display-matrix angles become normalized clockwise rotations", () => {
  for (const [input, expected] of [
    [-90, 90],
    [90, 270],
    [-180, 180],
    [0, 0],
    [-450, 90],
    [360, 0],
    [-22.5, 22.5],
  ]) {
    const stream = rotatedVideo({
      side_data_list: [{ side_data_type: "Display Matrix", rotation: input }],
    });

    assert.equal(stream.rotationDegrees, expected);
    assert.equal(Object.is(stream.rotationDegrees, -0), false);
  }
});

test("display-matrix rotation takes priority over legacy tags including zero", () => {
  for (const [matrix, expected] of [
    [-90, 90],
    [0, 0],
  ]) {
    const stream = rotatedVideo({
      tags: { rotate: "180" },
      side_data_list: [{ side_data_type: "Display Matrix", rotation: matrix }],
    });

    assert.equal(stream.rotationDegrees, expected);
  }
});

test("legacy rotation tags are normalized when no display matrix exists", () => {
  for (const [input, expected] of [
    ["90", 90],
    ["-90", 270],
    ["450", 90],
    ["-360", 0],
    ["22.5", 22.5],
  ]) {
    const stream = rotatedVideo({
      tags: { rotate: input },
      side_data_list: [{ side_data_type: "Unrelated metadata", rotation: 180 }],
    });

    assert.equal(stream.rotationDegrees, expected);
  }
});

test("invalid or ambiguous display matrices do not fall back to rotation tags", () => {
  const cases = [
    null,
    {},
    [null],
    [{ side_data_type: "Display Matrix" }],
    [{ side_data_type: "Display Matrix", rotation: "N/A" }],
    [{ side_data_type: "Display Matrix", rotation: true }],
    [{ side_data_type: "Display Matrix", rotation: "1e999" }],
    [
      { side_data_type: "Display Matrix", rotation: -90 },
      { side_data_type: "Display Matrix", rotation: 90 },
    ],
  ];

  for (const sideData of cases) {
    const stream = rotatedVideo({
      tags: { rotate: "180" },
      side_data_list: sideData,
    });

    assert.equal(stream.rotationDegrees, undefined);
  }
});

test("missing and malformed legacy rotation values remain unknown", () => {
  for (const tags of [
    undefined,
    null,
    [],
    {},
    { rotate: "" },
    { rotate: " " },
    { rotate: "90degrees" },
    { rotate: "Infinity" },
    { rotate: true },
    { rotate: {} },
  ]) {
    assert.equal(rotatedVideo({ tags }).rotationDegrees, undefined);
  }

  assert.equal(rotatedVideo().rotationDegrees, undefined);
});

test("rotation preserves stored dimensions and only applies to video streams", () => {
  const stream = rotatedVideo({
    side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
  });

  assert.equal(stream.rotationDegrees, 90);
  assert.equal(stream.width, 1920);
  assert.equal(stream.height, 1080);

  const result = parse({
    streams: [
      {
        index: 0,
        codec_type: "audio",
        tags: { rotate: "90" },
        side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
      },
    ],
  });

  assert.equal(result.streams[0].rotationDegrees, undefined);
  assert.deepEqual(captureMetadata(result), result);
  assert.deepEqual(captureMetadata({ streams: [stream] }).streams[0], stream);
});
