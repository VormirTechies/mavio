import assert from "node:assert/strict";
import test from "node:test";
import { validateNativeMp4Output } from "../../dist/engines/native/mp4-output.js";

function fixture(withAudio = true) {
  return {
    metadata: {
      container: "mov,mp4,m4a,3gp,3g2,mj2",
      durationSeconds: 2,
      sizeBytes: 90000,
      streams: [
        {
          index: 0,
          kind: "video",
          codec: "h264",
          width: 320,
          height: 180,
        },
        ...(withAudio
          ? [
              {
                index: 1,
                kind: "audio",
                codec: "aac",
                sampleRate: 48000,
                channels: 1,
              },
            ]
          : []),
      ],
    },
    streams: [
      {
        index: 0,
        attachedPicture: false,
        pixelFormat: "yuv420p",
        colorTransfer: "bt709",
        colorPrimaries: "bt709",
        colorSpace: "bt709",
        colorRange: "tv",
      },
      ...(withAudio ? [{ index: 1, channelLayout: "mono" }] : []),
    ],
  };
}

function expectation(withAudio = true) {
  return {
    width: 320,
    height: 180,
    ...(withAudio
      ? {
          audio: {
            sampleRate: 48000,
            channels: 1,
            channelLayout: "mono",
          },
        }
      : {}),
  };
}

function rejectsOutput(output, reason, expected = expectation()) {
  assert.throws(
    () => validateNativeMp4Output(output, expected, "output-check"),
    (error) => {
      assert.equal(error.code, "EXECUTION_FAILED");
      assert.equal(error.stage, "finalizing");
      assert.equal(error.jobId, "output-check");
      assert.equal(error.details.reason, reason);
      return true;
    },
  );
}

test("MP4 output validation accepts matching audio/video and video-only results", () => {
  for (const withAudio of [true, false]) {
    const output = fixture(withAudio);
    const before = structuredClone(output);

    validateNativeMp4Output(output, expectation(withAudio));
    assert.deepEqual(output, before);
  }
});

test("MP4 output validation rejects unexpected container, duration, or size", () => {
  for (const [field, value, reason] of [
    ["container", "matroska,webm", "OUTPUT_CONTAINER_MISMATCH"],
    ["durationSeconds", undefined, "INVALID_OUTPUT_DURATION"],
    ["durationSeconds", 0, "INVALID_OUTPUT_DURATION"],
    ["durationSeconds", Infinity, "INVALID_OUTPUT_DURATION"],
    ["sizeBytes", 0, "INVALID_OUTPUT_SIZE"],
    ["sizeBytes", undefined, "INVALID_OUTPUT_SIZE"],
  ]) {
    const output = fixture();
    output.metadata[field] = value;
    rejectsOutput(output, reason);
  }
});

test("MP4 output validation rejects missing, extra, or synthesized streams", () => {
  const missingAudio = fixture(false);
  rejectsOutput(missingAudio, "OUTPUT_STREAMS_MISMATCH");

  rejectsOutput(fixture(), "OUTPUT_STREAMS_MISMATCH", expectation(false));

  for (const kind of ["subtitle", "other", "video", "audio"]) {
    const output = fixture();
    output.metadata.streams.push({ index: 5, kind });
    rejectsOutput(output, "OUTPUT_STREAMS_MISMATCH");
  }

  const missingVideo = fixture();
  missingVideo.metadata.streams.shift();
  rejectsOutput(missingVideo, "OUTPUT_STREAMS_MISMATCH");
});

test("MP4 output validation rejects changed video codec or dimensions", () => {
  for (const [field, value, reason] of [
    ["codec", "hevc", "OUTPUT_VIDEO_CODEC_MISMATCH"],
    ["width", 160, "OUTPUT_DIMENSIONS_MISMATCH"],
    ["height", 90, "OUTPUT_DIMENSIONS_MISMATCH"],
  ]) {
    const output = fixture();
    output.metadata.streams[0][field] = value;
    rejectsOutput(output, reason);
  }
});

test("MP4 output validation rejects lost or changed video profile details", () => {
  for (const [field, value] of [
    ["attachedPicture", true],
    ["pixelFormat", "yuv420p10le"],
    ["colorTransfer", undefined],
    ["colorPrimaries", "bt2020"],
    ["colorSpace", undefined],
    ["colorRange", "pc"],
  ]) {
    const output = fixture();
    output.streams[0][field] = value;
    rejectsOutput(output, "OUTPUT_VIDEO_PROFILE_MISMATCH");
  }

  const missingDetails = fixture();
  missingDetails.streams.shift();
  rejectsOutput(missingDetails, "OUTPUT_VIDEO_PROFILE_MISMATCH");
});

test("MP4 output validation rejects changed audio encoding or layout", () => {
  for (const [field, value, reason] of [
    ["codec", "mp3", "OUTPUT_AUDIO_CODEC_MISMATCH"],
    ["sampleRate", 44100, "OUTPUT_AUDIO_PROFILE_MISMATCH"],
    ["channels", 2, "OUTPUT_AUDIO_PROFILE_MISMATCH"],
  ]) {
    const output = fixture();
    output.metadata.streams[1][field] = value;
    rejectsOutput(output, reason);
  }

  const changedLayout = fixture();
  changedLayout.streams[1].channelLayout = "stereo";
  rejectsOutput(changedLayout, "OUTPUT_AUDIO_PROFILE_MISMATCH");

  const missingDetails = fixture();
  missingDetails.streams.pop();
  rejectsOutput(missingDetails, "OUTPUT_AUDIO_PROFILE_MISMATCH");
});

test("normalized output geometry accepts square pixels and default orientation", () => {
  const output = fixture();
  output.streams[0].sampleAspectRatio = "1:1";
  output.streams[0].defaultOrientation = true;

  assert.doesNotThrow(() =>
    validateNativeMp4Output(output, {
      ...expectation(),
      requireNormalizedGeometry: true,
    }),
  );
});

test("normalized output rejects incorrect or unknown sample aspect ratios", () => {
  for (const sampleAspectRatio of [undefined, "4:3", "0:1", "unknown"]) {
    const output = fixture();
    output.streams[0].sampleAspectRatio = sampleAspectRatio;
    output.streams[0].defaultOrientation = true;

    rejectsOutput(output, "OUTPUT_SAMPLE_ASPECT_RATIO_MISMATCH", {
      ...expectation(),
      requireNormalizedGeometry: true,
    });
  }
});

test("normalized output rejects unknown orientation and contradictory rotation", () => {
  for (const [defaultOrientation, rotationDegrees] of [
    [undefined, undefined],
    [false, 0],
    [true, 90],
  ]) {
    const output = fixture();
    output.streams[0].sampleAspectRatio = "1:1";
    output.streams[0].defaultOrientation = defaultOrientation;
    output.metadata.streams[0].rotationDegrees = rotationDegrees;

    rejectsOutput(output, "OUTPUT_ORIENTATION_MISMATCH", {
      ...expectation(),
      requireNormalizedGeometry: true,
    });
  }
});

test("output-validation errors identify the selected video preset", () => {
  for (const preset of [undefined, "video-balanced-v1", "video-small-v1"]) {
    const output = fixture();
    output.metadata.sizeBytes = 0;

    assert.throws(
      () => validateNativeMp4Output(output, { ...expectation(), preset }, "preset-output-check"),
      (error) => {
        assert.equal(error.code, "EXECUTION_FAILED");
        assert.equal(error.stage, "finalizing");
        assert.equal(error.jobId, "preset-output-check");
        assert.equal(error.details.reason, "INVALID_OUTPUT_SIZE");
        assert.equal(error.details.preset, preset ?? "video-balanced-v1");
        return true;
      },
    );
  }
});
