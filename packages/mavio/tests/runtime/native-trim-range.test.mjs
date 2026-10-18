import assert from "node:assert/strict";
import test from "node:test";
import { resolveNativeTrimRange } from "../../dist/engines/native/trim-range.js";

const trim = (start, end) => ({
  type: "trim",
  options: { start, end },
});

test("untrimmed plans do not require duration or invent a trim interval", () => {
  assert.equal(resolveNativeTrimRange([], undefined), undefined);

  assert.equal(
    resolveNativeTrimRange(
      [{ type: "compress", options: { preset: "video-balanced-v1" } }],
      undefined,
    ),
    undefined,
  );
});

test("consecutive trims resolve against the preceding logical interval", () => {
  const transformations = [
    trim(2, 8),
    {
      type: "convert",
      options: { format: "mp4", preset: "video-balanced-v1" },
    },
    trim(1, 3),
  ];

  const before = structuredClone(transformations);
  const result = resolveNativeTrimRange(transformations, 10);

  assert.deepEqual(result, {
    startSeconds: 3,
    endSeconds: 5,
  });
  assert.deepEqual(transformations, before);
  assert.ok(Object.isFrozen(result));

  assert.deepEqual(resolveNativeTrimRange([trim(0.125, 1.875), trim(0.25, 0.75)], 2), {
    startSeconds: 0.375,
    endSeconds: 0.875,
  });
});

test("trim bounds use logical duration and never clamp an excessive end", () => {
  assert.deepEqual(resolveNativeTrimRange([trim(2, 8), trim(0, 6)], 10), {
    startSeconds: 2,
    endSeconds: 8,
  });

  assert.throws(
    () =>
      resolveNativeTrimRange(
        [trim(2, 8), { type: "compress", options: { preset: "video-balanced-v1" } }, trim(0, 7)],
        10,
      ),
    (error) => {
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.operation, "trim");
      assert.equal(error.details.reason, "OUT_OF_RANGE");
      assert.equal(error.details.operationIndex, 2);
      return true;
    },
  );
});

test("trim planning rejects unknown duration and malformed intervals", () => {
  for (const duration of [undefined, NaN, Infinity, -1]) {
    assert.throws(
      () => resolveNativeTrimRange([trim(0, 1)], duration),
      (error) => {
        assert.equal(error.code, "INVALID_MEDIA");
        assert.equal(error.details.reason, "UNKNOWN_DURATION");
        return true;
      },
    );
  }

  for (const [start, end] of [
    [-1, 1],
    [1, 1],
    [2, 1],
    [NaN, 1],
    [0, Infinity],
  ]) {
    assert.throws(
      () => resolveNativeTrimRange([trim(start, end)], 10),
      (error) => {
        assert.equal(error.code, "INVALID_OPTIONS");
        assert.equal(error.details.reason, "INVALID_TRIM_RANGE");
        return true;
      },
    );
  }
});

test("trim planning rejects intervals lost when adding a large source offset", () => {
  const offset = 2 ** 53;

  assert.throws(
    () => resolveNativeTrimRange([trim(offset, offset + 4), trim(0, 0.5)], offset + 4),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
      assert.equal(error.details.reason, "TIMELINE_PRECISION_LIMIT");
      assert.equal(error.details.operationIndex, 1);
      return true;
    },
  );
});
