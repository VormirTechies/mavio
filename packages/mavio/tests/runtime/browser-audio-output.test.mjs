import assert from "node:assert/strict";
import test from "node:test";
import { validateBrowserAudioOutput } from "../../dist/engines/browser/audio-output.js";

function fixture({
  preset = "audio-balanced-v1",
  sampleRate = 48000,
  channels = 2,
  tagged = true,
  junk = false,
} = {}) {
  const expected = {
    preset,
    sampleRate,
    channels,
    channelLayout: channels === 1 ? "mono" : "stereo",
  };

  let bytes;

  if (preset === "audio-balanced-v1") {
    const offset = tagged ? 10 : 0;
    const frameSize = Math.floor((144000 * 128) / sampleRate);

    bytes = new Uint8Array(offset + frameSize);

    if (tagged) {
      bytes.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
    }

    bytes.set(
      [0xff, 0xfb, 0x90 | (sampleRate === 48000 ? 4 : 0), channels === 1 ? 0xc0 : 0],
      offset,
    );
  } else {
    const extra = junk ? 10 : 0;
    const dataSize = channels * 2 * 8;

    bytes = new Uint8Array(44 + extra + dataSize);

    const view = new DataView(bytes.buffer);
    const text = (offset, value) => {
      bytes.set(new TextEncoder().encode(value), offset);
    };

    text(0, "RIFF");
    view.setUint32(4, bytes.length - 8, true);
    text(8, "WAVE");

    let offset = 12;

    if (junk) {
      text(offset, "JUNK");
      view.setUint32(offset + 4, 1, true);
      bytes[offset + 8] = 7;
      offset += 10;
    }

    text(offset, "fmt ");
    view.setUint32(offset + 4, 16, true);
    view.setUint16(offset + 8, 1, true);
    view.setUint16(offset + 10, channels, true);
    view.setUint32(offset + 12, sampleRate, true);
    view.setUint32(offset + 16, sampleRate * channels * 2, true);
    view.setUint16(offset + 20, channels * 2, true);
    view.setUint16(offset + 22, 16, true);

    offset += 24;
    text(offset, "data");
    view.setUint32(offset + 4, dataSize, true);
  }

  const output = {
    metadata: {
      container: preset === "audio-balanced-v1" ? "mp3" : "wav",
      durationSeconds: 0.1,
      sizeBytes: bytes.length,
      streams: [
        {
          index: 0,
          kind: "audio",
          codec: preset === "audio-balanced-v1" ? "mp3" : "pcm_s16le",
          sampleRate,
          channels,
        },
      ],
    },
    streams: [
      {
        index: 0,
        channelLayout: expected.channelLayout,
      },
    ],
  };

  return { output, expected, bytes };
}

function validate(value) {
  validateBrowserAudioOutput(value.output, value.expected, value.bytes, "audio-output-test");
}

function rejects(value, reason) {
  assert.throws(() => validate(value), {
    code: "EXECUTION_FAILED",
    stage: "finalizing",
    jobId: "audio-output-test",
    details: { reason, preset: value.expected.preset },
  });
}

test("browser audio accepts both presets, rates and channel counts without mutation", () => {
  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    for (const sampleRate of [44100, 48000]) {
      for (const channels of [1, 2]) {
        const value = fixture({ preset, sampleRate, channels });
        const metadataBefore = structuredClone(value.output);
        const bytesBefore = value.bytes.slice();

        validate(value);

        assert.deepEqual(value.output, metadataBefore);
        assert.deepEqual(value.bytes, bytesBefore);
      }
    }
  }
});

test("browser audio preserves shared metadata validation", () => {
  const value = fixture();
  value.output.metadata.streams[0].codec = "aac";

  rejects(value, "OUTPUT_AUDIO_CODEC_MISMATCH");
});

test("browser audio rejects a byte-size mismatch", () => {
  const value = fixture();
  value.output.metadata.sizeBytes += 1;

  rejects(value, "OUTPUT_BYTE_SIZE_MISMATCH");
});

test("browser MP3 accepts an untagged frame and rejects ID3-only output", () => {
  validate(fixture({ tagged: false }));

  const value = fixture();
  value.bytes = value.bytes.slice(0, 10);
  value.output.metadata.sizeBytes = value.bytes.length;

  rejects(value, "INVALID_MP3_SIGNATURE");
});

test("browser MP3 rejects malformed tags and incomplete frames", () => {
  const malformedTag = fixture();
  malformedTag.bytes[6] = 0x80;
  rejects(malformedTag, "INVALID_MP3_SIGNATURE");

  const truncated = fixture();
  truncated.bytes = truncated.bytes.slice(0, -1);
  truncated.output.metadata.sizeBytes = truncated.bytes.length;
  rejects(truncated, "INVALID_MP3_SIGNATURE");
});

test("browser MP3 cross-checks header rate and channels", () => {
  const rate = fixture();
  rate.bytes[12] = 0x90;
  rejects(rate, "OUTPUT_AUDIO_HEADER_MISMATCH");

  const channels = fixture();
  channels.bytes[13] = 0xc0;
  rejects(channels, "OUTPUT_AUDIO_HEADER_MISMATCH");
});

test("browser WAV accepts padded unknown chunks and offset byte views", () => {
  const value = fixture({ preset: "audio-pcm-v1", junk: true });
  const backing = new Uint8Array(value.bytes.length + 9);

  backing.set(value.bytes, 5);
  value.bytes = backing.subarray(5, 5 + value.bytes.length);

  validate(value);
});

test("browser WAV rejects invalid lengths and missing data", () => {
  const length = fixture({ preset: "audio-pcm-v1" });
  new DataView(length.bytes.buffer).setUint32(4, 1, true);
  rejects(length, "INVALID_WAV_STRUCTURE");

  const missing = fixture({ preset: "audio-pcm-v1" });
  missing.bytes.set(new TextEncoder().encode("JUNK"), 36);
  rejects(missing, "INVALID_WAV_STRUCTURE");
});

test("browser WAV cross-checks PCM headers and data alignment", () => {
  const profile = fixture({ preset: "audio-pcm-v1" });
  new DataView(profile.bytes.buffer).setUint16(34, 24, true);
  rejects(profile, "OUTPUT_AUDIO_HEADER_MISMATCH");

  const alignment = fixture({ preset: "audio-pcm-v1" });
  const view = new DataView(alignment.bytes.buffer);
  view.setUint32(40, alignment.bytes.length - 45, true);
  rejects(alignment, "INVALID_WAV_STRUCTURE");
});
