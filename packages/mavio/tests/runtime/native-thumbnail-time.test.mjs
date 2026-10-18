import assert from "node:assert/strict";
import test from "node:test";
import { resolveNativeThumbnailTime } from "../../dist/engines/native/thumbnail-time.js";

test("thumbnail time without trims refers directly to the source", () => {
  for (const at of [0, 0.25, 1.5]) {
    const result = resolveNativeThumbnailTime([], 2, at);

    assert.deepEqual(result, {
      sourceAtSeconds: at,
      sourceEndSeconds: 2,
    });
    assert.equal(Object.isFrozen(result), true);
  }
});

test("thumbnail time follows consecutive trims and ignores resize for timing", () => {
  const transformations = [
    { type: "trim", options: { start: 1, end: 5 } },
    { type: "resize", options: { width: 160, height: 90 } },
    { type: "trim", options: { start: 0.5, end: 2.5 } },
  ];
  const before = structuredClone(transformations);

  assert.deepEqual(resolveNativeThumbnailTime(transformations, 8, 0.25), {
    sourceAtSeconds: 1.75,
    sourceEndSeconds: 3.5,
  });

  assert.deepEqual(transformations, before);
});

test("thumbnail time rejects invalid request values", () => {
  for (const at of [-1, NaN, Infinity, "0.5", undefined]) {
    assert.throws(() => resolveNativeThumbnailTime([], 2, at), {
      code: "INVALID_OPTIONS",
      operation: "thumbnail",
      details: { reason: "INVALID_THUMBNAIL_TIME" },
    });
  }
});

test("thumbnail time requires known duration", () => {
  for (const duration of [undefined, NaN, Infinity, -1]) {
    assert.throws(() => resolveNativeThumbnailTime([], duration, 0), {
      code: "INVALID_MEDIA",
      details: { reason: "UNKNOWN_DURATION" },
    });
  }
});

test("thumbnail time rejects end boundaries and invalid preceding trim ranges", () => {
  for (const [transformations, duration, at] of [
    [[], 2, 2],
    [[], 0, 0],
    [[{ type: "trim", options: { start: 1, end: 2 } }], 3, 1],
  ]) {
    assert.throws(() => resolveNativeThumbnailTime(transformations, duration, at), {
      code: "INVALID_OPTIONS",
      details: { reason: "OUT_OF_RANGE" },
    });
  }

  assert.throws(
    () =>
      resolveNativeThumbnailTime(
        [
          { type: "trim", options: { start: 1, end: 3 } },
          { type: "trim", options: { start: 0, end: 2.5 } },
        ],
        4,
        0,
      ),
    {
      code: "INVALID_OPTIONS",
      details: { reason: "OUT_OF_RANGE", operationIndex: 1 },
    },
  );
});

test("thumbnail time rejects invalid composition and collapsed time offsets", () => {
  for (const transformation of [
    { type: "extractAudio", options: {} },
    { type: "compress", options: { preset: "video-balanced-v1" } },
    {
      type: "convert",
      options: { format: "mp4", preset: "video-balanced-v1" },
    },
  ]) {
    assert.throws(() => resolveNativeThumbnailTime([transformation], 2, 0), {
      code: "INVALID_OPTIONS",
      details: { reason: "INVALID_THUMBNAIL_TRANSFORMATION" },
    });
  }

  const start = 2 ** 53;

  assert.throws(
    () =>
      resolveNativeThumbnailTime(
        [{ type: "trim", options: { start, end: start + 4 } }],
        start + 8,
        0.5,
      ),
    {
      code: "UNSUPPORTED_CAPABILITY",
      details: { reason: "TIMELINE_PRECISION_LIMIT" },
    },
  );
});
