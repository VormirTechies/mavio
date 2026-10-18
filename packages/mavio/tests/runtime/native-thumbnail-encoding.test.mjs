import assert from "node:assert/strict";
import test from "node:test";
import { buildNativeThumbnailEncoding } from "../../dist/engines/native/thumbnail-encoding.js";

function inventory(overrides = {}) {
  return {
    encoders: ["mjpeg", "png"],
    decoders: [],
    muxers: ["image2pipe"],
    demuxers: [],
    filters: [],
    ...overrides,
  };
}

test("JPEG thumbnail settings match the approved preset", () => {
  assert.deepEqual(buildNativeThumbnailEncoding("jpeg-balanced-v1", inventory()), [
    "-c:v",
    "mjpeg",
    "-q:v",
    "3",
    "-pix_fmt",
    "yuvj420p",
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
  ]);
});

test("PNG thumbnail settings match the approved preset", () => {
  assert.deepEqual(buildNativeThumbnailEncoding("png-lossless-v1", inventory()), [
    "-c:v",
    "png",
    "-pix_fmt",
    "rgb24",
    "-compression_level",
    "6",
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
  ]);
});

test("thumbnail encoding requires the exact encoder without fallback", () => {
  for (const [preset, encoder] of [
    ["jpeg-balanced-v1", "mjpeg"],
    ["png-lossless-v1", "png"],
  ]) {
    assert.throws(
      () =>
        buildNativeThumbnailEncoding(
          preset,
          inventory({
            encoders: inventory().encoders.filter((candidate) => candidate !== encoder),
          }),
        ),
      {
        code: "UNSUPPORTED_CAPABILITY",
        stage: "preparing",
        details: {
          reason: "MISSING_ENCODER",
          component: encoder,
          preset,
        },
      },
    );
  }
});

test("thumbnail encoding requires the image muxer", () => {
  for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
    assert.throws(() => buildNativeThumbnailEncoding(preset, inventory({ muxers: ["mp4"] })), {
      code: "UNSUPPORTED_CAPABILITY",
      details: {
        reason: "MISSING_MUXER",
        component: "image2pipe",
        preset,
      },
    });
  }
});

test("thumbnail settings are immutable and reject unrelated presets", () => {
  for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
    const input = inventory();
    const before = structuredClone(input);
    const args = buildNativeThumbnailEncoding(preset, input);

    assert.equal(Object.isFrozen(args), true);
    assert.throws(() => args.push("-vf", "scale=160:90"), TypeError);
    assert.deepEqual(input, before);

    for (const option of ["-ss", "-t", "-vf", "-af", "-ar", "-ac"]) {
      assert.equal(args.includes(option), false);
    }
  }

  for (const preset of ["video-balanced-v1", "audio-pcm-v1", "", undefined]) {
    assert.throws(() => buildNativeThumbnailEncoding(preset, inventory()), {
      code: "INVALID_OPTIONS",
      details: { reason: "INVALID_NATIVE_THUMBNAIL_PRESET" },
    });
  }
});
