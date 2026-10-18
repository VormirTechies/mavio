import assert from "node:assert/strict";
import test from "node:test";
import { buildNativeThumbnailFilters } from "../../dist/engines/native/thumbnail-filters.js";

function inventory(filters = ["trim", "setpts"]) {
  return {
    encoders: [],
    decoders: [],
    muxers: [],
    demuxers: [],
    filters,
  };
}

const time = {
  sourceAtSeconds: 0.51,
  sourceEndSeconds: 1.49,
};

test("thumbnail filters select by timestamp within the retained interval", () => {
  const result = buildNativeThumbnailFilters(time, 0, inventory());

  assert.deepEqual(result.inputArgs, ["-copyts"]);
  assert.equal(result.video, "trim=start=510000us:end=1490000us,setpts=PTS-STARTPTS");
});

test("thumbnail filters support time zero and return immutable settings", () => {
  const input = inventory();
  const before = structuredClone(input);

  const result = buildNativeThumbnailFilters({ sourceAtSeconds: 0, sourceEndSeconds: 2 }, 0, input);

  assert.equal(result.video, "trim=start=0us:end=2000000us,setpts=PTS-STARTPTS");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.inputArgs), true);
  assert.deepEqual(input, before);
});

test("thumbnail filters reject invalid selection intervals", () => {
  for (const invalid of [
    { sourceAtSeconds: -1, sourceEndSeconds: 1 },
    { sourceAtSeconds: 1, sourceEndSeconds: 1 },
    { sourceAtSeconds: 2, sourceEndSeconds: 1 },
    { sourceAtSeconds: NaN, sourceEndSeconds: 1 },
    { sourceAtSeconds: 0, sourceEndSeconds: Infinity },
  ]) {
    assert.throws(() => buildNativeThumbnailFilters(invalid, 0, inventory()), {
      code: "INVALID_OPTIONS",
      operation: "thumbnail",
      details: { reason: "INVALID_THUMBNAIL_INTERVAL" },
    });
  }
});

test("thumbnail filters reject unknown and nonzero time origins", () => {
  for (const origin of [undefined, -1, 0.25, NaN, Infinity]) {
    assert.throws(() => buildNativeThumbnailFilters(time, origin, inventory()), {
      code: "UNSUPPORTED_CAPABILITY",
      details: { reason: "UNSUPPORTED_TIME_ORIGIN" },
    });
  }
});

test("thumbnail filters reject precision loss instead of rounding", () => {
  for (const interval of [
    { sourceAtSeconds: 0.0000001, sourceEndSeconds: 1 },
    { sourceAtSeconds: 0, sourceEndSeconds: 1.0000001 },
    {
      sourceAtSeconds: 10_000_000_000,
      sourceEndSeconds: 10_000_000_001,
    },
  ]) {
    assert.throws(() => buildNativeThumbnailFilters(interval, 0, inventory()), {
      code: "UNSUPPORTED_CAPABILITY",
      details: { reason: "UNSUPPORTED_THUMBNAIL_PRECISION" },
    });
  }
});

test("thumbnail filters require selection and timestamp-reset filters", () => {
  for (const missing of ["trim", "setpts"]) {
    const available = ["trim", "setpts"].filter((filter) => filter !== missing);

    assert.throws(() => buildNativeThumbnailFilters(time, 0, inventory(available)), {
      code: "UNSUPPORTED_CAPABILITY",
      operation: "thumbnail",
      details: { reason: "MISSING_FILTER", filter: missing },
    });
  }
});
