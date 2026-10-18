import assert from "node:assert/strict";
import test from "node:test";
import { parseNativeProbeDetails } from "../../dist/engines/native/probe-details.js";
import { parseNativeProbeMetadata } from "../../dist/engines/native/probe-metadata.js";

test("detailed probing preserves technical fields without exposing them publicly", () => {
  const text = JSON.stringify({
    format: {
      duration: "2",
      start_time: "-0.125",
    },
    streams: [
      {
        index: 3,
        codec_type: "video",
        codec_name: "hevc",
        pix_fmt: "yuv420p10le",
        color_transfer: "smpte2084",
        color_primaries: "bt2020",
        color_space: "bt2020nc",
        color_range: "tv",
        sample_aspect_ratio: "4:3",
        start_time: "0.25",
        disposition: { attached_pic: 0 },
      },
      {
        index: 7,
        codec_type: "audio",
        codec_name: "aac",
        channel_layout: "stereo",
        start_time: "-0.021333",
      },
    ],
  });

  const result = parseNativeProbeDetails(text);

  assert.deepEqual(result.metadata, parseNativeProbeMetadata(text));
  assert.equal(result.formatStartTimeSeconds, -0.125);
  assert.equal(result.streams[0].index, 3);
  assert.equal(result.streams[0].pixelFormat, "yuv420p10le");
  assert.equal(result.streams[0].colorTransfer, "smpte2084");
  assert.equal(result.streams[0].colorPrimaries, "bt2020");
  assert.equal(result.streams[0].colorSpace, "bt2020nc");
  assert.equal(result.streams[0].colorRange, "tv");
  assert.equal(result.streams[0].sampleAspectRatio, "4:3");
  assert.equal(result.streams[0].startTimeSeconds, 0.25);
  assert.equal(result.streams[0].attachedPicture, false);
  assert.equal(result.streams[1].channelLayout, "stereo");
  assert.equal(result.streams[1].startTimeSeconds, -0.021333);
  assert.equal("pixelFormat" in result.metadata.streams[0], false);
});

test("unknown technical values do not become compatibility assumptions", () => {
  for (const invalidTime of ["N/A", "", " ", "0x10", "Infinity", null, true]) {
    const result = parseNativeProbeDetails(
      JSON.stringify({
        format: { start_time: invalidTime },
        streams: [
          {
            index: 0,
            codec_type: "video",
            pix_fmt: "unknown",
            color_transfer: "unspecified",
            color_primaries: "N/A",
            color_space: "",
            channel_layout: "unknown",
            start_time: invalidTime,
            disposition: { attached_pic: "1" },
          },
        ],
      }),
    );

    assert.equal(result.formatStartTimeSeconds, undefined);
    assert.equal(result.streams[0].startTimeSeconds, undefined);
    assert.equal(result.streams[0].pixelFormat, undefined);
    assert.equal(result.streams[0].colorTransfer, undefined);
    assert.equal(result.streams[0].colorPrimaries, undefined);
    assert.equal(result.streams[0].colorSpace, undefined);
    assert.equal(result.streams[0].channelLayout, undefined);
    assert.equal(result.streams[0].attachedPicture, undefined);
  }
});

test("attached pictures remain identifiable and internal stream details are frozen", () => {
  const result = parseNativeProbeDetails(
    JSON.stringify({
      streams: [
        {
          index: 9,
          codec_type: "video",
          disposition: { attached_pic: 1 },
          start_time: 0,
        },
        {
          index: 2,
          codec_type: "audio",
        },
      ],
    }),
  );

  assert.equal(result.streams[0].attachedPicture, true);
  assert.equal(result.streams[0].startTimeSeconds, 0);
  assert.equal(result.streams[1].attachedPicture, undefined);
  assert.deepEqual(
    result.streams.map((stream) => stream.index),
    [9, 2],
  );
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.streams));
  assert.ok(result.streams.every(Object.isFrozen));
});

test("detailed probing retains existing malformed-response validation", () => {
  for (const text of [
    "{",
    JSON.stringify({ streams: null }),
    JSON.stringify({
      streams: [
        { index: 0, codec_type: "video" },
        { index: 0, codec_type: "audio" },
      ],
    }),
  ]) {
    assert.throws(
      () => parseNativeProbeDetails(text, "details-job"),
      (error) => {
        assert.equal(error.code, "EXECUTION_FAILED");
        assert.equal(error.jobId, "details-job");
        assert.equal(error.details.reason, "INVALID_PROBE_RESPONSE");
        return true;
      },
    );
  }
});
