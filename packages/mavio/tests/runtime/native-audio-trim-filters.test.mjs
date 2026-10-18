import assert from "node:assert/strict";
import test from "node:test";
import { buildNativeAudioTrimFilters } from "../../dist/engines/native/audio-trim-filters.js";

function inventory(filters = ["atrim", "asetpts"]) {
  return {
    encoders: [],
    decoders: [],
    muxers: [],
    demuxers: [],
    filters,
  };
}

const range = { startSeconds: 0.51, endSeconds: 1.49 };

test("audio trim uses the requested fractional interval and time origin", () => {
  const result = buildNativeAudioTrimFilters(range, 0, inventory());

  assert.deepEqual(result.inputArgs, ["-copyts"]);
  assert.equal(result.audio, "atrim=start=510000us:end=1490000us,asetpts=PTS-510000/(1000000*TB)");
  assert.equal(result.audio.includes("STARTPTS"), false);
});

test("audio trim settings are immutable and require no video components", () => {
  const input = inventory();
  const before = structuredClone(input);
  const result = buildNativeAudioTrimFilters(range, 0, input);

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.inputArgs), true);
  assert.deepEqual(input, before);
  assert.deepEqual(Object.keys(result).sort(), ["audio", "inputArgs"]);
});

test("audio trim rejects invalid intervals", () => {
  for (const invalid of [
    { startSeconds: -1, endSeconds: 1 },
    { startSeconds: 1, endSeconds: 1 },
    { startSeconds: 2, endSeconds: 1 },
    { startSeconds: NaN, endSeconds: 1 },
    { startSeconds: 0, endSeconds: Infinity },
  ]) {
    assert.throws(() => buildNativeAudioTrimFilters(invalid, 0, inventory()), {
      code: "INVALID_OPTIONS",
      operation: "trim",
      details: { reason: "INVALID_TRIM_RANGE" },
    });
  }
});

test("audio trim rejects unknown and nonzero source origins", () => {
  for (const origin of [undefined, -1, 0.023021, NaN, Infinity]) {
    assert.throws(() => buildNativeAudioTrimFilters(range, origin, inventory()), {
      code: "UNSUPPORTED_CAPABILITY",
      details: { reason: "UNSUPPORTED_TIME_ORIGIN" },
    });
  }
});

test("audio trim rejects unsupported precision instead of rounding", () => {
  for (const interval of [
    { startSeconds: 0.0000001, endSeconds: 1 },
    { startSeconds: 0, endSeconds: 1.0000001 },
    { startSeconds: 10_000_000_000, endSeconds: 10_000_000_001 },
  ]) {
    assert.throws(() => buildNativeAudioTrimFilters(interval, 0, inventory()), {
      code: "UNSUPPORTED_CAPABILITY",
      details: { reason: "UNSUPPORTED_TRIM_PRECISION" },
    });
  }
});

test("audio trim requires each audio filter without fallback", () => {
  for (const missing of ["atrim", "asetpts"]) {
    const available = ["atrim", "asetpts"].filter((filter) => filter !== missing);

    assert.throws(() => buildNativeAudioTrimFilters(range, 0, inventory(available)), {
      code: "UNSUPPORTED_CAPABILITY",
      operation: "trim",
      details: { reason: "MISSING_FILTER", filter: missing },
    });
  }
});
