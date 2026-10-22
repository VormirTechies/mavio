import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserThumbnailEncoding } from "../../dist/engines/browser/thumbnail-encoding.js";

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

test("browser JPEG uses the approved preset and one encoding thread", () => {
  assert.deepEqual(buildBrowserThumbnailEncoding("jpeg-balanced-v1", inventory()), [
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
    "-threads:v",
    "1",
  ]);
});

test("browser PNG uses the approved lossless preset and one encoding thread", () => {
  assert.deepEqual(buildBrowserThumbnailEncoding("png-lossless-v1", inventory()), [
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
    "-threads:v",
    "1",
  ]);
});

test("browser thumbnail presets require their exact encoder without fallback", () => {
  for (const [preset, encoder] of [
    ["jpeg-balanced-v1", "mjpeg"],
    ["png-lossless-v1", "png"],
  ]) {
    assert.throws(
      () =>
        buildBrowserThumbnailEncoding(
          preset,
          inventory({
            encoders: ["mjpeg", "png"].filter((candidate) => candidate !== encoder),
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

test("browser thumbnail encoding requires the image muxer", () => {
  for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
    assert.throws(() => buildBrowserThumbnailEncoding(preset, inventory({ muxers: ["mp4"] })), {
      code: "UNSUPPORTED_CAPABILITY",
      details: {
        reason: "MISSING_MUXER",
        component: "image2pipe",
        preset,
      },
    });
  }
});

test("browser thumbnail encoding rejects unrelated or missing presets", () => {
  for (const preset of ["video-balanced-v1", "audio-pcm-v1", "", undefined]) {
    assert.throws(() => buildBrowserThumbnailEncoding(preset, inventory()), {
      code: "INVALID_OPTIONS",
      stage: "preparing",
      details: {
        reason: "INVALID_BROWSER_THUMBNAIL_PRESET",
      },
    });
  }
});

test("browser thumbnail settings are immutable and leave input and execution policy untouched", () => {
  for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
    const available = inventory();
    const before = structuredClone(available);

    const args = buildBrowserThumbnailEncoding(preset, available);

    assert.equal(Object.isFrozen(args), true);
    assert.deepEqual(available, before);
    assert.throws(() => args.push("-vf", "scale=160:90"), TypeError);

    for (const flag of ["-i", "-ss", "-t", "-vf", "-af", "-ar", "-ac", "-n", "-y"]) {
      assert.equal(args.includes(flag), false);
    }
  }
});
