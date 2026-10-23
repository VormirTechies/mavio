import assert from "node:assert/strict";
import test from "node:test";
import { validateBalancedMp4Source } from "../../dist/engines/native/mp4-source.js";
import { parseNativeProbeDetails } from "../../dist/engines/native/probe-details.js";

function source({ video = {}, audio = {}, withAudio = true, extraStreams = [] } = {}) {
  return parseNativeProbeDetails(
    JSON.stringify({
      streams: [
        {
          index: 3,
          codec_type: "video",
          codec_name: "h264",
          pix_fmt: "yuv420p",
          color_transfer: "bt709",
          color_primaries: "bt709",
          color_space: "bt709",
          color_range: "tv",
          disposition: { attached_pic: 0 },
          ...video,
        },
        ...(withAudio
          ? [
              {
                index: 7,
                codec_type: "audio",
                codec_name: "aac",
                sample_rate: "48000",
                channels: 2,
                channel_layout: "stereo",
                ...audio,
              },
            ]
          : []),
        ...extraStreams,
      ],
    }),
  );
}

function rejectsProfile(input, reason, streamIndex) {
  const snapshot = structuredClone(input);

  for (const preset of ["video-balanced-v1", "video-small-v1"]) {
    assert.throws(
      () => validateBalancedMp4Source(input, preset),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
        assert.equal(error.stage, "preparing");
        assert.equal(error.details.reason, reason);
        assert.equal(error.details.streamIndex, streamIndex);
        assert.equal(error.details.preset, preset);
        return true;
      },
    );
    assert.deepEqual(input, snapshot);
  }
}

test("MP4 source validation accepts the initial explicit video and audio profiles", () => {
  for (const sampleRate of [44100, 48000]) {
    for (const [channels, layout] of [
      [1, "mono"],
      [2, "stereo"],
    ]) {
      const input = source({
        audio: {
          sample_rate: String(sampleRate),
          channels,
          channel_layout: layout,
        },
      });

      assert.deepEqual(validateBalancedMp4Source(input), {
        videoStreamIndex: 3,
        audioStreamIndex: 7,
      });
    }
  }

  assert.deepEqual(validateBalancedMp4Source(source({ withAudio: false })), {
    videoStreamIndex: 3,
  });
});

test("MP4 source validation rejects high-depth, alpha, and unknown pixel formats", () => {
  for (const pixelFormat of ["yuv420p10le", "yuva420p", "unknown", undefined]) {
    rejectsProfile(source({ video: { pix_fmt: pixelFormat } }), "UNSUPPORTED_PIXEL_FORMAT", 3);
  }
});

test("MP4 source validation rejects HDR, unknown colors, and unvalidated range", () => {
  for (const video of [
    { color_transfer: "smpte2084" },
    { color_transfer: "arib-std-b67" },
    { color_transfer: undefined },
    { color_primaries: "bt2020" },
    { color_space: "unknown" },
    { color_range: "pc" },
  ]) {
    rejectsProfile(source({ video }), "UNSUPPORTED_COLOR_PROFILE", 3);
  }
});

test("MP4 source validation rejects unsupported rates and inconsistent audio layouts", () => {
  for (const sampleRate of ["96000", "unknown", undefined]) {
    rejectsProfile(
      source({ audio: { sample_rate: sampleRate } }),
      "UNSUPPORTED_AUDIO_SAMPLE_RATE",
      7,
    );
  }

  for (const audio of [
    { channels: 6, channel_layout: "5.1" },
    { channels: 2, channel_layout: "mono" },
    { channels: 1, channel_layout: "stereo" },
    { channel_layout: undefined },
  ]) {
    rejectsProfile(source({ audio }), "UNSUPPORTED_AUDIO_LAYOUT", 7);
  }
});

test("MP4 source validation keeps first-stream selection and ignores omitted streams", () => {
  rejectsProfile(
    source({
      video: { disposition: { attached_pic: 1 } },
      extraStreams: [{ index: 9, codec_type: "video", codec_name: "h264" }],
    }),
    "UNSUPPORTED_VIDEO_DISPOSITION",
    3,
  );

  rejectsProfile(source({ video: { disposition: undefined } }), "UNSUPPORTED_VIDEO_DISPOSITION", 3);

  const selected = validateBalancedMp4Source(
    source({
      extraStreams: [
        {
          index: 9,
          codec_type: "audio",
          sample_rate: "96000",
          channels: 6,
          channel_layout: "5.1",
        },
        { index: 11, codec_type: "subtitle" },
      ],
    }),
  );

  assert.deepEqual(selected, {
    videoStreamIndex: 3,
    audioStreamIndex: 7,
  });
  assert.ok(Object.isFrozen(selected));
});
