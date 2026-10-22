import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserAudioTrimPlan } from "../../dist/engines/browser/audio-trim-plan.js";

function inventory(filters = ["atrim", "asetpts"]) {
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

function plan(transformations, duration = 2, origin = 0, available = inventory()) {
  return buildBrowserAudioTrimPlan(transformations, duration, origin, available);
}

test("untrimmed browser audio requires neither timing metadata nor trim filters", () => {
  assert.equal(buildBrowserAudioTrimPlan([], undefined, undefined, inventory([])), undefined);
});

test("fractional browser audio trim preserves the requested time origin", () => {
  const result = plan([trim(0.125, 0.375)]);

  assert.deepEqual(result.range, {
    startSeconds: 0.125,
    endSeconds: 0.375,
  });

  assert.deepEqual(result.inputArgs, ["-copyts"]);

  assert.equal(
    result.audio,
    "atrim=start=125000us:end=375000us," + "asetpts=PTS-125000/(1000000*TB)",
  );

  assert.equal(result.audio.includes("STARTPTS"), false);
});

test("consecutive browser audio trims resolve against the current logical clip", () => {
  const result = plan([trim(2, 8), trim(1, 3)], 10);

  assert.deepEqual(result.range, {
    startSeconds: 3,
    endSeconds: 5,
  });

  assert.equal(
    result.audio,
    "atrim=start=3000000us:end=5000000us," + "asetpts=PTS-3000000/(1000000*TB)",
  );
});

test("browser audio trim needs only audio timing filters", () => {
  assert.ok(plan([trim(0, 1)], 2, 0, inventory()));

  for (const missing of ["atrim", "asetpts"]) {
    const available = inventory(["atrim", "asetpts"].filter((name) => name !== missing));

    assert.throws(() => plan([trim(0, 1)], 2, 0, available), {
      code: "UNSUPPORTED_CAPABILITY",
      operation: "trim",
      details: {
        reason: "MISSING_FILTER",
        filter: missing,
      },
    });
  }
});

test("browser audio trim rejects unsupported time origins", () => {
  for (const origin of [undefined, NaN, Infinity, -1, 1]) {
    assert.throws(() => buildBrowserAudioTrimPlan([trim(0, 1)], 2, origin, inventory()), {
      code: "UNSUPPORTED_CAPABILITY",
      details: { reason: "UNSUPPORTED_TIME_ORIGIN" },
    });
  }
});

test("browser audio trim rejects intervals that cannot preserve microsecond precision", () => {
  for (const end of [0.0000005, 1 / 3]) {
    assert.throws(() => plan([trim(0, end)]), {
      code: "UNSUPPORTED_CAPABILITY",
      details: { reason: "UNSUPPORTED_TRIM_PRECISION" },
    });
  }
});

test("browser audio trim rejects invalid ranges and unknown duration", () => {
  for (const [start, end] of [
    [-1, 1],
    [1, 1],
    [2, 1],
    [NaN, 1],
    [0, Infinity],
  ]) {
    assert.throws(() => plan([trim(start, end)]), {
      code: "INVALID_OPTIONS",
      details: {
        reason: "INVALID_TRIM_RANGE",
        operationIndex: 0,
      },
    });
  }

  assert.throws(() => plan([trim(0, 3)]), {
    code: "INVALID_OPTIONS",
    details: {
      reason: "OUT_OF_RANGE",
      operationIndex: 0,
    },
  });

  assert.throws(() => buildBrowserAudioTrimPlan([trim(0, 1)], undefined, 0, inventory()), {
    code: "INVALID_MEDIA",
    details: {
      reason: "UNKNOWN_DURATION",
      operationIndex: 0,
    },
  });
});

test("browser audio trim plans are immutable and leave inputs unchanged", () => {
  const transformations = [trim(0.125, 1.875), trim(0.125, 0.375)];
  const available = inventory();

  const before = structuredClone({
    transformations,
    available,
  });

  const result = plan(transformations, 2, 0, available);

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.range), true);
  assert.equal(Object.isFrozen(result.inputArgs), true);

  assert.deepEqual({ transformations, available }, before);
});
