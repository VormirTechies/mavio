import assert from "node:assert/strict";
import test from "node:test";
import { captureTransformation } from "../../dist/core/transformations.js";

function rejects(type, options, reason) {
  assert.throws(
    () => captureTransformation(type, options),
    (error) => {
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.operation, type);
      assert.equal(error.stage, "queued");
      assert.equal(error.jobId, undefined);
      assert.equal(error.details.reason, reason);
      return true;
    },
  );
}

test("required options reject missing or malformed objects", () => {
  for (const type of ["trim", "resize", "convert", "compress"]) {
    for (const value of [undefined, null, [], "invalid"]) {
      rejects(type, value, "INVALID_SHAPE");
    }
  }

  rejects("extractAudio", null, "INVALID_SHAPE");
});

test("trim accepts fractional seconds and rejects invalid intervals", () => {
  assert.deepEqual(captureTransformation("trim", { start: 0.25, end: 1.75 }).options, {
    start: 0.25,
    end: 1.75,
  });

  for (const [start, end] of [
    [-1, 2],
    [1, 1],
    [2, 1],
    [NaN, 2],
    [0, Infinity],
    ["0", 2],
  ]) {
    rejects("trim", { start, end }, "INVALID_RANGE");
  }
});

test("resize requires positive integer dimensions", () => {
  assert.deepEqual(captureTransformation("resize", { width: 1280, height: 720 }).options, {
    width: 1280,
    height: 720,
  });

  for (const value of [0, -1, 1.5, NaN, Infinity, "720", undefined]) {
    rejects("resize", { width: value, height: 720 }, "INVALID_DIMENSIONS");
    rejects("resize", { width: 1280, height: value }, "INVALID_DIMENSIONS");
  }
});

test("encoding declarations recognize all approved preset mappings", () => {
  const pairs = [
    ["video-balanced-v1", "mp4"],
    ["video-small-v1", "mp4"],
    ["audio-balanced-v1", "mp3"],
    ["audio-pcm-v1", "wav"],
    ["jpeg-balanced-v1", "jpeg"],
    ["png-lossless-v1", "png"],
  ];

  for (const [preset, format] of pairs) {
    assert.deepEqual(captureTransformation("convert", { preset, format }).options, {
      preset,
      format,
    });
    assert.deepEqual(captureTransformation("compress", { preset }).options, { preset });
  }

  for (const preset of ["unknown", "toString", "__proto__", undefined]) {
    rejects("compress", { preset }, "UNKNOWN_PRESET");
  }

  for (const format of ["wav", "webm", undefined]) {
    rejects("convert", { preset: "video-balanced-v1", format }, "PRESET_FORMAT_MISMATCH");
  }
});

test("audio extraction preserves default selection and absolute indices", () => {
  assert.deepEqual(captureTransformation("extractAudio").options, {});
  assert.deepEqual(captureTransformation("extractAudio", { streamIndex: 0 }).options, {
    streamIndex: 0,
  });

  for (const streamIndex of [-1, 0.5, NaN, Infinity, "0", null]) {
    rejects("extractAudio", { streamIndex }, "INVALID_STREAM_INDEX");
  }
});

test("transformation options are independent frozen snapshots", () => {
  const options = { start: 1, end: 3 };
  const captured = captureTransformation("trim", options);

  options.start = 99;

  assert.deepEqual(captured.options, { start: 1, end: 3 });
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.options));
});
