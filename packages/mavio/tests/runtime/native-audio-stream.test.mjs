import assert from "node:assert/strict";
import test from "node:test";
import { selectNativeAudioStream } from "../../dist/engines/native/audio-stream.js";

function source() {
  return {
    streams: [
      { index: 0, kind: "video" },
      { index: 7, kind: "audio" },
      { index: 2, kind: "audio" },
      { index: 9, kind: "subtitle" },
    ],
  };
}

const invalidIndex = {
  code: "INVALID_OPTIONS",
  stage: "preparing",
  details: { reason: "INVALID_STREAM_INDEX" },
};

test("audio selection defaults to source order rather than lowest index", () => {
  assert.deepEqual(selectNativeAudioStream(source()), {
    audioStreamIndex: 7,
  });
});

test("explicit audio selection uses an absolute source stream index", () => {
  assert.deepEqual(selectNativeAudioStream(source(), 2), {
    audioStreamIndex: 2,
  });

  assert.deepEqual(selectNativeAudioStream(source(), 7), {
    audioStreamIndex: 7,
  });
});

test("audio selection rejects absent and non-audio indexes", () => {
  for (const index of [0, 1, 9, 99]) {
    assert.throws(() => selectNativeAudioStream(source(), index), invalidIndex);
  }
});

test("audio selection rejects malformed indexes without falling back", () => {
  for (const index of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "7", null]) {
    assert.throws(() => selectNativeAudioStream(source(), index), invalidIndex);
  }
});

test("missing required audio differs from an invalid explicit selection", () => {
  for (const metadata of [{ streams: [] }, { streams: [{ index: 0, kind: "video" }] }]) {
    assert.throws(() => selectNativeAudioStream(metadata), {
      code: "INVALID_MEDIA",
      stage: "preparing",
      details: { reason: "MISSING_AUDIO" },
    });

    assert.throws(() => selectNativeAudioStream(metadata, 7), invalidIndex);
  }
});

test("audio-only input supports index zero and selection is immutable", () => {
  const metadata = Object.freeze({
    streams: Object.freeze([Object.freeze({ index: 0, kind: "audio" })]),
  });

  for (const selected of [
    selectNativeAudioStream(metadata),
    selectNativeAudioStream(metadata, 0),
  ]) {
    assert.deepEqual(selected, { audioStreamIndex: 0 });
    assert.equal(Object.isFrozen(selected), true);
    assert.throws(() => {
      selected.audioStreamIndex = 5;
    }, TypeError);
  }

  assert.deepEqual(metadata.streams, [{ index: 0, kind: "audio" }]);
});
