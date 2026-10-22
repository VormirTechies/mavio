import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserAudioEncoding } from "../../dist/engines/browser/audio-encoding.js";

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

test("browser balanced audio maps to approved MP3 settings", () => {
  assert.deepEqual(buildBrowserAudioEncoding("audio-balanced-v1", inventory()), [
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    "-f",
    "mp3",
    "-threads:a",
    "1",
  ]);
});

test("browser PCM audio maps to signed 16-bit WAV", () => {
  assert.deepEqual(buildBrowserAudioEncoding("audio-pcm-v1", inventory()), [
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    "-threads:a",
    "1",
  ]);
});

test("browser audio requires the exact encoder without fallback", () => {
  for (const [preset, encoder] of [
    ["audio-balanced-v1", "libmp3lame"],
    ["audio-pcm-v1", "pcm_s16le"],
  ]) {
    const available = inventory();

    available.encoders = available.encoders.filter((candidate) => candidate !== encoder);

    assert.throws(() => buildBrowserAudioEncoding(preset, available), {
      code: "UNSUPPORTED_CAPABILITY",
      stage: "preparing",
      details: {
        reason: "MISSING_ENCODER",
        component: encoder,
        preset,
      },
    });
  }
});

test("browser audio requires its exact output muxer", () => {
  for (const [preset, format] of [
    ["audio-balanced-v1", "mp3"],
    ["audio-pcm-v1", "wav"],
  ]) {
    const available = inventory();

    available.muxers = available.muxers.filter((candidate) => candidate !== format);

    assert.throws(() => buildBrowserAudioEncoding(preset, available), {
      code: "UNSUPPORTED_CAPABILITY",
      stage: "preparing",
      details: {
        reason: "MISSING_MUXER",
        component: format,
        preset,
      },
    });
  }
});

test("browser audio mappings preserve inputs and leave stream properties to source planning", () => {
  const available = inventory();
  const before = structuredClone(available);

  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    const args = buildBrowserAudioEncoding(preset, available);

    assert.equal(Object.isFrozen(args), true);

    assert.throws(() => args.push("-ar", "44100"), TypeError);

    for (const flag of ["-ar", "-ac", "-af", "-ss", "-t", "-y", "-n"]) {
      assert.equal(args.includes(flag), false);
    }
  }

  assert.deepEqual(available, before);
});

test("browser audio rejects unrelated and unknown presets", () => {
  for (const preset of ["video-balanced-v1", "jpeg-balanced-v1", "", undefined]) {
    assert.throws(() => buildBrowserAudioEncoding(preset, inventory()), {
      code: "INVALID_OPTIONS",
      details: {
        reason: "INVALID_BROWSER_AUDIO_PRESET",
      },
    });
  }
});
