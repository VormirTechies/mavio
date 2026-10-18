import assert from "node:assert/strict";
import test from "node:test";
import { validateNativeThumbnailSource } from "../../dist/engines/native/thumbnail-source.js";

function source() {
  return {
    metadata: {
      streams: [
        { index: 0, kind: "audio", sampleRate: 96000, channels: 6 },
        { index: 7, kind: "video", width: 320, height: 180 },
        { index: 2, kind: "video", width: 640, height: 360 },
      ],
    },
    streams: [
      { index: 0, channelLayout: "5.1" },
      {
        index: 7,
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
  };
}

function rejects(input, reason, code = "UNSUPPORTED_CAPABILITY") {
  assert.throws(() => validateNativeThumbnailSource(input), {
    code,
    operation: "thumbnail",
    details: { reason, streamIndex: 7 },
  });
}

test("thumbnail source selects first video by source order and ignores audio profile", () => {
  const input = source();
  const before = structuredClone(input);
  const selected = validateNativeThumbnailSource(input);

  assert.deepEqual(selected, {
    videoStreamIndex: 7,
    width: 320,
    height: 180,
  });
  assert.equal(Object.isFrozen(selected), true);
  assert.deepEqual(input, before);
});

test("thumbnail source requires video and matching technical details", () => {
  const missingVideo = source();
  missingVideo.metadata.streams = [{ index: 0, kind: "audio" }];

  assert.throws(() => validateNativeThumbnailSource(missingVideo), {
    code: "INVALID_MEDIA",
    details: { reason: "MISSING_VIDEO" },
  });

  const missingDetails = source();
  missingDetails.streams = [{ index: 0 }];
  rejects(missingDetails, "MISSING_STREAM_DETAILS");
});

test("thumbnail source rejects attached pictures and unsupported pixel formats", () => {
  for (const attachedPicture of [true, undefined]) {
    const input = source();
    input.streams[1].attachedPicture = attachedPicture;
    rejects(input, "UNSUPPORTED_VIDEO_DISPOSITION");
  }

  for (const pixelFormat of ["yuv420p10le", "rgba", undefined]) {
    const input = source();
    input.streams[1].pixelFormat = pixelFormat;
    rejects(input, "UNSUPPORTED_PIXEL_FORMAT");
  }
});

test("thumbnail source requires the validated SDR color profile", () => {
  for (const [field, value] of [
    ["colorTransfer", "smpte2084"],
    ["colorPrimaries", "bt2020"],
    ["colorSpace", "bt2020nc"],
    ["colorRange", "pc"],
    ["colorTransfer", undefined],
  ]) {
    const input = source();
    input.streams[1][field] = value;
    rejects(input, "UNSUPPORTED_COLOR_PROFILE");
  }
});

test("thumbnail source rejects unhandled orientation and pixel geometry", () => {
  for (const orientation of [false, undefined]) {
    const input = source();
    input.streams[1].defaultOrientation = orientation;
    rejects(input, "UNSUPPORTED_THUMBNAIL_ORIENTATION");
  }

  const rotated = source();
  rotated.metadata.streams[1].rotationDegrees = 90;
  rejects(rotated, "UNSUPPORTED_THUMBNAIL_ORIENTATION");

  for (const ratio of ["4:3", undefined]) {
    const input = source();
    input.streams[1].sampleAspectRatio = ratio;
    rejects(input, "UNSUPPORTED_THUMBNAIL_SAMPLE_ASPECT_RATIO");
  }
});

test("thumbnail source requires positive integer dimensions", () => {
  for (const field of ["width", "height"]) {
    for (const value of [undefined, 0, -1, 1.5, Infinity]) {
      const input = source();
      input.metadata.streams[1][field] = value;

      rejects(input, "INVALID_SOURCE_DIMENSIONS", "INVALID_MEDIA");
    }
  }
});
