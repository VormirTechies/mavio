import assert from "node:assert/strict";
import test from "node:test";
import { buildNativeResizeFilters } from "../../dist/engines/native/resize-filters.js";

function inventory(filters = ["scale", "setsar"]) {
  return {
    encoders: [],
    decoders: [],
    muxers: [],
    demuxers: [],
    filters,
  };
}

function resize(width, height) {
  return { type: "resize", options: { width, height } };
}

test("resize filters use fitted dimensions and explicit square pixels", () => {
  const result = buildNativeResizeFilters(
    { width: 320, height: 180 },
    [resize(101, 101)],
    inventory(),
  );

  assert.equal(result.video, "scale=w=100:h=56:flags=lanczos,setsar=1");
  assert.deepEqual(result.dimensions, { width: 100, height: 56 });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.dimensions));
});

test("consecutive resize filters preserve intermediate dimensions", () => {
  const result = buildNativeResizeFilters(
    { width: 320, height: 180 },
    [
      resize(101, 101),
      { type: "compress", options: { preset: "video-balanced-v1" } },
      resize(80, 80),
    ],
    inventory(),
  );

  assert.equal(
    result.video,
    ["scale=w=100:h=56:flags=lanczos,setsar=1", "scale=w=80:h=44:flags=lanczos,setsar=1"].join(","),
  );
  assert.deepEqual(result.dimensions, { width: 80, height: 44 });
});

test("plans without resize do not require resize filters", () => {
  const result = buildNativeResizeFilters(
    { width: 320, height: 180 },
    [{ type: "trim", options: { start: 0, end: 1 } }],
    inventory([]),
  );

  assert.equal(result, undefined);
});

test("resize rejects missing filters and invalid dimensions", () => {
  for (const missing of ["scale", "setsar"]) {
    assert.throws(
      () =>
        buildNativeResizeFilters(
          { width: 320, height: 180 },
          [resize(160, 90)],
          inventory(["scale", "setsar"].filter((name) => name !== missing)),
        ),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
        assert.equal(error.operation, "resize");
        assert.equal(error.details.reason, "MISSING_FILTER");
        assert.equal(error.details.filter, missing);
        return true;
      },
    );
  }

  assert.throws(
    () => buildNativeResizeFilters({ width: 320, height: 180 }, [resize(1, 1)], inventory()),
    (error) => {
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.details.reason, "INVALID_DIMENSIONS");
      return true;
    },
  );
});
