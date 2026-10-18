import assert from "node:assert/strict";
import test from "node:test";
import { buildNativeAudioEncoding } from "../../dist/engines/native/audio-encoding.js";

function inventory(overrides = {}) {
  return {
    encoders: ["libmp3lame", "pcm_s16le"],
    decoders: [],
    muxers: ["mp3", "wav"],
    demuxers: [],
    filters: [],
    ...overrides,
  };
}

test("balanced audio uses the approved MP3 encoding settings", () => {
  const args = buildNativeAudioEncoding("audio-balanced-v1", inventory());

  assert.deepEqual(args, ["-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3"]);
});

test("PCM audio uses signed 16-bit little-endian WAV encoding", () => {
  const args = buildNativeAudioEncoding("audio-pcm-v1", inventory());

  assert.deepEqual(args, ["-c:a", "pcm_s16le", "-f", "wav"]);
});

test("audio presets require their exact encoder without fallback", () => {
  for (const [preset, encoder] of [
    ["audio-balanced-v1", "libmp3lame"],
    ["audio-pcm-v1", "pcm_s16le"],
  ]) {
    assert.throws(
      () =>
        buildNativeAudioEncoding(
          preset,
          inventory({
            encoders: inventory().encoders.filter((candidate) => candidate !== encoder),
          }),
        ),
      {
        code: "UNSUPPORTED_CAPABILITY",
        stage: "preparing",
        details: {
          reason: "MISSING_ENCODER",
          component: encoder,
          preset,
        },
      },
    );
  }
});

test("audio presets require their exact output muxer", () => {
  for (const [preset, format] of [
    ["audio-balanced-v1", "mp3"],
    ["audio-pcm-v1", "wav"],
  ]) {
    assert.throws(
      () =>
        buildNativeAudioEncoding(
          preset,
          inventory({
            muxers: inventory().muxers.filter((candidate) => candidate !== format),
          }),
        ),
      {
        code: "UNSUPPORTED_CAPABILITY",
        stage: "preparing",
        details: {
          reason: "MISSING_MUXER",
          component: format,
          preset,
        },
      },
    );
  }
});

test("audio encoding settings are immutable and reject unrelated presets", () => {
  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    const args = buildNativeAudioEncoding(preset, inventory());

    assert.equal(Object.isFrozen(args), true);
    assert.throws(() => args.push("-ar", "44100"), TypeError);

    for (const option of ["-ar", "-ac", "-af", "-ss", "-t"]) {
      assert.equal(args.includes(option), false);
    }
  }

  for (const preset of ["video-balanced-v1", "", undefined]) {
    assert.throws(() => buildNativeAudioEncoding(preset, inventory()), {
      code: "INVALID_OPTIONS",
      details: { reason: "INVALID_NATIVE_AUDIO_PRESET" },
    });
  }
});
