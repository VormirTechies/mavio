import test from "node:test";
import assert from "node:assert/strict";
import { parseNativeProbeMetadata } from "../../dist/engines/native/probe-metadata.js";
import { parseBrowserProbeMetadata } from "../../dist/engines/browser/probe-metadata.js";

const jobId = "m5-metadata-parity";

function parseAll(payload) {
  const text = JSON.stringify(payload);
  return [
    parseNativeProbeMetadata(text, jobId),
    parseBrowserProbeMetadata(text, 0, jobId),
    parseBrowserProbeMetadata(text, -1, jobId),
  ];
}

function assertParity(payload, verify) {
  const snapshot = structuredClone(payload);
  const results = parseAll(payload);

  for (const result of results) {
    assert.deepEqual(result, results[0]);
    verify(result);
  }

  assert.deepEqual(payload, snapshot);
}

test("metadata parsers agree on normalized fields, stream order and private-field exclusion", () => {
  assertParity(
    {
      format: {
        duration: "1.25",
        size: "2048",
        bit_rate: "131072",
        format_name: "mov,mp4,m4a,3gp,3g2,mj2",
        tags: { comment: "private-format-tag" },
      },
      streams: [
        {
          index: 7,
          codec_type: "video",
          codec_name: "h264",
          width: 320,
          height: 180,
          avg_frame_rate: "30000/1001",
          tags: { rotate: "90", comment: "private-stream-tag" },
        },
        {
          index: 0,
          codec_type: "audio",
          codec_name: "aac",
          sample_rate: "48000",
          channels: 2,
        },
        { index: 4, codec_type: "data", codec_name: "bin_data" },
      ],
    },
    (metadata) => {
      assert.equal(metadata.durationSeconds, 1.25);
      assert.equal(metadata.sizeBytes, 2048);
      assert.equal(metadata.bitrateBitsPerSecond, 131072);
      assert.equal(metadata.container, "mov,mp4,m4a,3gp,3g2,mj2");
      assert.deepEqual(
        metadata.streams.map((stream) => stream.index),
        [7, 0, 4],
      );
      assert.equal(metadata.streams[0].width, 320);
      assert.equal(metadata.streams[0].height, 180);
      assert.equal(metadata.streams[0].rotationDegrees, 90);
      assert.deepEqual(metadata.streams[0].frameRate, { numerator: 30000, denominator: 1001 });
      assert.equal(metadata.streams[1].sampleRate, 48000);
      assert.equal(metadata.streams[1].channels, 2);
      assert.equal(metadata.streams[2].kind, "other");
      assert.equal(JSON.stringify(metadata).includes("private-"), false);
    },
  );
});

test("metadata parsers preserve unknown values without inventing duration or frame rate", () => {
  assertParity(
    {
      format: { duration: "N/A", size: "-1", bit_rate: "Infinity", format_name: "" },
      streams: [
        {
          index: 0,
          codec_type: "video",
          width: 0,
          height: "unknown",
          avg_frame_rate: "0/0",
          r_frame_rate: "24/1",
          duration: "99",
        },
        { index: 1, codec_type: "audio", sample_rate: null, channels: 0 },
      ],
    },
    (metadata) => {
      for (const field of ["durationSeconds", "sizeBytes", "bitrateBitsPerSecond", "container"]) {
        assert.equal(metadata[field], undefined);
      }
      for (const field of ["codec", "width", "height", "frameRate", "rotationDegrees"]) {
        assert.equal(metadata.streams[0][field], undefined);
      }
      assert.equal(metadata.streams[1].sampleRate, undefined);
      assert.equal(metadata.streams[1].channels, undefined);
    },
  );
});

test("metadata parsers preserve known zero duration and size", () => {
  assertParity(
    {
      format: { duration: 0, size: "0", bit_rate: 0 },
      streams: [{ index: 0, codec_type: "subtitle" }],
    },
    (metadata) => {
      assert.equal(metadata.durationSeconds, 0);
      assert.equal(metadata.sizeBytes, 0);
      assert.equal(metadata.bitrateBitsPerSecond, 0);
      assert.equal(metadata.streams[0].kind, "subtitle");
    },
  );
});

test("metadata parsers agree on display-matrix rotation and ambiguous rotation", () => {
  assertParity(
    {
      format: {},
      streams: [
        {
          index: 0,
          codec_type: "video",
          side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
          tags: { rotate: "180" },
        },
        {
          index: 1,
          codec_type: "video",
          side_data_list: [
            { side_data_type: "Display Matrix", rotation: 0 },
            { side_data_type: "Display Matrix", rotation: -90 },
          ],
          tags: { rotate: "180" },
        },
      ],
    },
    (metadata) => {
      assert.equal(metadata.streams[0].rotationDegrees, 90);
      assert.equal(metadata.streams[1].rotationDegrees, undefined);
    },
  );
});

test("metadata parser results do not share nested mutable output", () => {
  const payload = {
    format: {},
    streams: [{ index: 0, codec_type: "video", avg_frame_rate: "24/1" }],
  };
  const results = parseAll(payload);

  results[0].streams[0].frameRate.numerator = 1;

  assert.equal(results[1].streams[0].frameRate.numerator, 24);
  assert.equal(results[2].streams[0].frameRate.numerator, 24);
  assert.equal(parseAll(payload)[0].streams[0].frameRate.numerator, 24);
});

for (const [name, text] of [
  ["malformed JSON", '{"private-marker":'],
  [
    "duplicate indexes",
    JSON.stringify({
      format: {},
      streams: [{ index: 0 }, { index: 0 }],
    }),
  ],
  [
    "invalid stream index",
    JSON.stringify({
      format: {},
      streams: [{ index: "0" }],
    }),
  ],
]) {
  test("metadata parsers reject " + name + " with bounded job context", () => {
    for (const parse of [
      (value) => parseNativeProbeMetadata(value, jobId),
      (value) => parseBrowserProbeMetadata(value, 0, jobId),
      (value) => parseBrowserProbeMetadata(value, -1, jobId),
    ]) {
      assert.throws(
        () => parse(text),
        (error) => {
          assert.equal(error.code, "EXECUTION_FAILED");
          assert.equal(error.stage, "preparing");
          assert.equal(error.jobId, jobId);
          assert.equal(error.details.reason, "INVALID_PROBE_RESPONSE");
          assert.equal(error.message.includes("private-marker"), false);
          assert.equal(error.cause, undefined);
          return true;
        },
      );
    }
  });
}

test("Browser parser response-shape requirements remain explicit", () => {
  // These are parser boundaries, not promises about public native probing.
  for (const payload of [
    { streams: [{ index: 0, codec_type: "audio" }] },
    { format: {}, streams: [] },
  ]) {
    const text = JSON.stringify(payload);
    assert.doesNotThrow(() => parseNativeProbeMetadata(text, jobId));

    for (const exitCode of [0, -1]) {
      assert.throws(
        () => parseBrowserProbeMetadata(text, exitCode, jobId),
        (error) =>
          error.code === "EXECUTION_FAILED" && error.details.reason === "INVALID_PROBE_RESPONSE",
      );
    }
  }
});
