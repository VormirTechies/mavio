import assert from "node:assert/strict";
import test from "node:test";
import { buildNativeTrimFilters } from "../../dist/engines/native/trim-filters.js";
import { resolveNativeTrimRange } from "../../dist/engines/native/trim-range.js";

function inventory(filters = ["trim", "settb", "setpts", "atrim", "asetpts"]) {
  return {
    encoders: [],
    decoders: [],
    muxers: [],
    demuxers: [],
    filters,
  };
}

test("trim filters use one requested time origin for video and audio", () => {
  const result = buildNativeTrimFilters(
    { startSeconds: 0.125, endSeconds: 1.875 },
    0,
    true,
    inventory(),
  );

  assert.deepEqual(result.inputArgs, ["-copyts"]);
  assert.equal(
    result.video,
    "trim=start=125000us:end=1875000us,settb=expr=1/1000000,setpts=PTS-125000/(1000000*TB)",
  );
  assert.equal(result.audio, "atrim=start=125000us:end=1875000us,asetpts=PTS-125000/(1000000*TB)");
  assert.equal(result.video.includes("STARTPTS"), false);
  assert.equal(result.audio.includes("STARTPTS"), false);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.inputArgs));
});

test("video-only trimming does not require audio filters", () => {
  const result = buildNativeTrimFilters(
    { startSeconds: 0, endSeconds: 1 },
    0,
    false,
    inventory(["trim", "settb", "setpts"]),
  );

  assert.equal(result.audio, undefined);

  assert.throws(
    () =>
      buildNativeTrimFilters(
        { startSeconds: 0, endSeconds: 1 },
        0,
        true,
        inventory(["trim", "settb", "setpts"]),
      ),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
      assert.equal(error.details.reason, "MISSING_FILTER");
      assert.equal(error.details.filter, "atrim");
      return true;
    },
  );
});

test("trim filters consume the combined logical range of consecutive trims", () => {
  const range = resolveNativeTrimRange(
    [
      { type: "trim", options: { start: 2, end: 8 } },
      { type: "trim", options: { start: 1, end: 3 } },
    ],
    10,
  );

  const result = buildNativeTrimFilters(range, 0, false, inventory());

  assert.equal(
    result.video,
    "trim=start=3000000us:end=5000000us,settb=expr=1/1000000,setpts=PTS-3000000/(1000000*TB)",
  );
});

test("trim filters reject unknown origins and unsupported precision", () => {
  for (const origin of [undefined, NaN, -1, 1]) {
    assert.throws(
      () => buildNativeTrimFilters({ startSeconds: 0, endSeconds: 1 }, origin, false, inventory()),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
        assert.equal(error.details.reason, "UNSUPPORTED_TIME_ORIGIN");
        return true;
      },
    );
  }

  for (const endSeconds of [0.0000005, 1 / 3, 1e20]) {
    assert.throws(
      () => buildNativeTrimFilters({ startSeconds: 0, endSeconds }, 0, false, inventory()),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
        assert.equal(error.details.reason, "UNSUPPORTED_TRIM_PRECISION");
        return true;
      },
    );
  }
});

test("trim filters reject malformed intervals", () => {
  for (const [startSeconds, endSeconds] of [
    [-1, 1],
    [1, 1],
    [2, 1],
    [NaN, 1],
    [0, Infinity],
  ]) {
    assert.throws(
      () => buildNativeTrimFilters({ startSeconds, endSeconds }, 0, false, inventory()),
      { code: "INVALID_OPTIONS" },
    );
  }
});

test("trim rejects a build without video time-base conversion", () => {
  assert.throws(
    () =>
      buildNativeTrimFilters(
        { startSeconds: 0.51, endSeconds: 1.49 },
        0,
        false,
        inventory(["trim", "setpts"]),
      ),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
      assert.equal(error.details.reason, "MISSING_FILTER");
      assert.equal(error.details.filter, "settb");
      return true;
    },
  );
});

test("trim supplies immutable MP4 timing options for both stream layouts", () => {
  for (const hasAudio of [false, true]) {
    const result = buildNativeTrimFilters(
      { startSeconds: 0.51, endSeconds: 1.49 },
      0,
      hasAudio,
      inventory(),
    );

    assert.deepEqual(result.mp4OutputArgs, [
      "-enc_time_base:v",
      "filter",
      "-video_track_timescale",
      "1000000",
      "-movie_timescale",
      "1000000",
      "-avoid_negative_ts",
      "disabled",
      "-use_editlist",
      "1",
    ]);

    assert.ok(Object.isFrozen(result.mp4OutputArgs));
    assert.throws(() => result.mp4OutputArgs.push("-shortest"), TypeError);
  }
});
