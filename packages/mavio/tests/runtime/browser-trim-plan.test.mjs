import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserTrimPlan } from "../../dist/engines/browser/trim-plan.js";

function inventory(filters = ["trim", "settb", "setpts", "atrim", "asetpts"]) {
  return {
    encoders: [],
    decoders: [],
    muxers: [],
    demuxers: [],
    filters,
  };
}

function trim(start, end) {
  return { type: "trim", options: { start, end } };
}

test("a browser plan without trim needs no trim filters or known duration", () => {
  const result = buildBrowserTrimPlan([], undefined, undefined, false, inventory([]));

  assert.equal(result, undefined);
});

test("fractional browser trim uses one requested origin and a numeric time base", () => {
  const result = buildBrowserTrimPlan([trim(0.125, 1.875)], 2, 0, true, inventory());

  assert.deepEqual(result.range, {
    startSeconds: 0.125,
    endSeconds: 1.875,
  });

  assert.equal(
    result.video,
    "trim=start=125000us:end=1875000us,settb=expr=1/1000000,setpts=PTS-125000/(1000000*TB)",
  );

  assert.equal(result.audio, "atrim=start=125000us:end=1875000us,asetpts=PTS-125000/(1000000*TB)");

  assert.deepEqual(result.inputArgs, ["-copyts"]);

  const index = result.mp4OutputArgs.indexOf("-enc_time_base:v");
  assert.equal(result.mp4OutputArgs[index + 1], "1:1000000");
  assert.equal(result.mp4OutputArgs.includes("filter"), false);

  assert.equal(result.video.includes("STARTPTS"), false);
  assert.equal(result.audio.includes("STARTPTS"), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.mp4OutputArgs), true);
});

test("consecutive browser trims resolve against the current logical clip", () => {
  const result = buildBrowserTrimPlan([trim(2, 8), trim(1, 3)], 10, 0, false, inventory());

  assert.deepEqual(result.range, {
    startSeconds: 3,
    endSeconds: 5,
  });

  assert.ok(result.video.startsWith("trim=start=3000000us:end=5000000us"));
});

test("video-only browser trim does not require audio filters", () => {
  const available = inventory(["trim", "settb", "setpts"]);

  const result = buildBrowserTrimPlan([trim(0, 1)], 2, 0, false, available);

  assert.equal(result.audio, undefined);

  assert.throws(
    () => buildBrowserTrimPlan([trim(0, 1)], 2, 0, true, available),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
      assert.equal(error.details.reason, "MISSING_FILTER");
      assert.equal(error.details.filter, "atrim");
      return true;
    },
  );
});

test("browser trim rejects missing video timing filters", () => {
  for (const missing of ["trim", "settb", "setpts"]) {
    const available = inventory(["trim", "settb", "setpts"].filter((name) => name !== missing));

    assert.throws(
      () => buildBrowserTrimPlan([trim(0, 1)], 2, 0, false, available),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
        assert.equal(error.details.filter, missing);
        return true;
      },
    );
  }
});

test("browser trim rejects precision that cannot round-trip through microseconds", () => {
  for (const end of [0.0000005, 1 / 3]) {
    assert.throws(
      () => buildBrowserTrimPlan([trim(0, end)], 2, 0, false, inventory()),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
        assert.equal(error.details.reason, "UNSUPPORTED_TRIM_PRECISION");
        return true;
      },
    );
  }
});

test("browser trim rejects unsupported source time origins", () => {
  for (const origin of [undefined, NaN, -1, 1]) {
    assert.throws(
      () => buildBrowserTrimPlan([trim(0, 1)], 2, origin, false, inventory()),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
        assert.equal(error.details.reason, "UNSUPPORTED_TIME_ORIGIN");
        return true;
      },
    );
  }
});

test("browser trim rejects invalid intervals and unknown source duration", () => {
  for (const [start, end] of [
    [-1, 1],
    [1, 1],
    [2, 1],
    [0, 3],
  ]) {
    assert.throws(() => buildBrowserTrimPlan([trim(start, end)], 2, 0, false, inventory()), {
      code: "INVALID_OPTIONS",
    });
  }

  assert.throws(() => buildBrowserTrimPlan([trim(0, 1)], undefined, 0, false, inventory()), {
    code: "INVALID_MEDIA",
  });
});
