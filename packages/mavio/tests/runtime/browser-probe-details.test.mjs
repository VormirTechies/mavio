import assert from "node:assert/strict";
import test from "node:test";
import { parseBrowserProbeDetails } from "../../dist/engines/browser/probe-details.js";
import { parseBrowserProbeMetadata } from "../../dist/engines/browser/probe-metadata.js";

function report() {
  return {
    format: {
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
      duration: "2",
      start_time: "0",
    },
    streams: [
      {
        index: 0,
        codec_type: "video",
        codec_name: "h264",
        width: 320,
        height: 180,
        avg_frame_rate: "24/1",
        pix_fmt: "yuv420p",
        color_transfer: "bt709",
        color_primaries: "bt709",
        color_space: "bt709",
        color_range: "tv",
        sample_aspect_ratio: "1:1",
        start_time: "0",
        disposition: { attached_pic: 0 },
      },
      {
        index: 2,
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
        channels: 2,
        channel_layout: "stereo",
        start_time: "-0.021333",
      },
    ],
  };
}

function parse(value, exitCode = -1) {
  return parseBrowserProbeDetails(JSON.stringify(value), exitCode, "browser-details-test");
}

test("browser details retain technical fields while public metadata stays unchanged", () => {
  const text = JSON.stringify(report());
  const result = parseBrowserProbeDetails(text, -1);

  assert.deepEqual(result.metadata, parseBrowserProbeMetadata(text, -1));

  assert.equal(result.formatStartTimeSeconds, 0);

  const video = result.streams[0];

  assert.equal(video.pixelFormat, "yuv420p");
  assert.equal(video.colorTransfer, "bt709");
  assert.equal(video.colorPrimaries, "bt709");
  assert.equal(video.colorSpace, "bt709");
  assert.equal(video.colorRange, "tv");
  assert.equal(video.sampleAspectRatio, "1:1");
  assert.equal(video.attachedPicture, false);
  assert.equal(video.defaultOrientation, true);

  assert.equal(result.streams[1].index, 2);
  assert.equal(result.streams[1].channelLayout, "stereo");
  assert.equal(result.streams[1].startTimeSeconds, -0.021333);

  assert.equal("pixelFormat" in result.metadata.streams[0], false);
  assert.equal("channelLayout" in result.metadata.streams[1], false);
});

test("unknown browser technical fields remain unknown", () => {
  const value = report();
  const video = value.streams[0];

  video.pix_fmt = "unknown";
  video.color_transfer = "unspecified";
  video.color_primaries = "N/A";
  video.color_space = "";
  video.sample_aspect_ratio = "unknown";
  video.disposition = { attached_pic: "0" };
  video.start_time = "N/A";
  value.streams[1].channel_layout = "unknown";

  const result = parse(value);

  assert.equal(result.streams[0].pixelFormat, undefined);
  assert.equal(result.streams[0].colorTransfer, undefined);
  assert.equal(result.streams[0].colorPrimaries, undefined);
  assert.equal(result.streams[0].colorSpace, undefined);
  assert.equal(result.streams[0].sampleAspectRatio, undefined);
  assert.equal(result.streams[0].attachedPicture, undefined);
  assert.equal(result.streams[0].startTimeSeconds, undefined);
  assert.equal(result.streams[1].channelLayout, undefined);
});

test("browser details identify rotation and attached artwork", () => {
  const value = report();

  value.streams[0].side_data_list = [
    {
      side_data_type: "Display Matrix",
      rotation: -90,
    },
  ];
  value.streams[0].disposition.attached_pic = 1;

  const result = parse(value);

  assert.equal(result.metadata.streams[0].rotationDegrees, 90);
  assert.equal(result.streams[0].defaultOrientation, false);
  assert.equal(result.streams[0].attachedPicture, true);
});

test("detailed browser probing retains strict exit and response validation", () => {
  assert.deepEqual(parse(report(), 0), parse(report(), -1));

  assert.throws(() => parse(report(), 1), {
    code: "EXECUTION_FAILED",
    details: { reason: "PROBE_EXIT_FAILURE" },
  });

  for (const value of [{}, { format: {}, streams: [] }, { streams: report().streams }]) {
    assert.throws(() => parse(value), {
      code: "EXECUTION_FAILED",
    });
  }

  const duplicate = report();
  duplicate.streams[1].index = 0;

  assert.throws(() => parse(duplicate), {
    code: "EXECUTION_FAILED",
  });
});

test("detailed browser probing preserves explicit invalid-media rejection", () => {
  const value = {
    ...report(),
    error: {
      code: -1094995529,
      string: "Invalid data",
    },
  };

  assert.throws(() => parse(value), {
    code: "INVALID_MEDIA",
    jobId: "browser-details-test",
    details: { reason: "PROBE_REJECTED_MEDIA" },
  });
});

test("internal browser stream details are frozen", () => {
  const result = parse(report());

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.streams), true);
  assert.equal(result.streams.every(Object.isFrozen), true);
});
