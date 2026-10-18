import assert from "node:assert/strict";
import test from "node:test";
import { validateNativeTrimSelection } from "../../dist/engines/native/trim-selection.js";

test("trim selection accepts populated required streams", () => {
  assert.doesNotThrow(() => validateNativeTrimSelection({ videoFrames: 1 }, false));

  assert.doesNotThrow(() =>
    validateNativeTrimSelection({ videoFrames: 23, audioSamples: 47040 }, true),
  );

  // An absent audio requirement must not reject video-only content.
  assert.doesNotThrow(() =>
    validateNativeTrimSelection({ videoFrames: 1, audioSamples: 0 }, false),
  );
});

test("empty video selection reports RANGE_TOO_SHORT with job context", () => {
  assert.throws(
    () =>
      validateNativeTrimSelection({ videoFrames: 0, audioSamples: 48 }, true, "trim-empty-video"),
    (error) => {
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.stage, "preparing");
      assert.equal(error.operation, "trim");
      assert.equal(error.jobId, "trim-empty-video");
      assert.equal(error.details.reason, "RANGE_TOO_SHORT");
      assert.equal(error.details.streamKind, "video");
      return true;
    },
  );
});

test("empty required audio selection reports RANGE_TOO_SHORT", () => {
  assert.throws(
    () => validateNativeTrimSelection({ videoFrames: 1, audioSamples: 0 }, true),
    (error) => {
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.details.reason, "RANGE_TOO_SHORT");
      assert.equal(error.details.streamKind, "audio");
      return true;
    },
  );
});

test("invalid video evidence is not classified as an empty interval", () => {
  for (const videoFrames of [
    undefined,
    null,
    "0",
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => validateNativeTrimSelection({ videoFrames }, false),
      (error) => {
        assert.equal(error.code, "EXECUTION_FAILED");
        assert.equal(error.details.reason, "INVALID_TRIM_SELECTION");
        assert.equal(error.details.field, "videoFrames");
        return true;
      },
    );
  }
});

test("missing or invalid required audio evidence takes precedence over emptiness", () => {
  for (const audioSamples of [
    undefined,
    null,
    "0",
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => validateNativeTrimSelection({ videoFrames: 0, audioSamples }, true),
      (error) => {
        assert.equal(error.code, "EXECUTION_FAILED");
        assert.equal(error.details.reason, "INVALID_TRIM_SELECTION");
        assert.equal(error.details.field, "audioSamples");
        return true;
      },
    );
  }
});
