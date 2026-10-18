import assert from "node:assert/strict";
import test from "node:test";
import { validateNativeAudioSource } from "../../dist/engines/native/audio-source.js";

const presets = ["audio-balanced-v1", "audio-pcm-v1"];

function source({ sampleRate = 48000, channels = 1, channelLayout = "mono" } = {}) {
  return {
    metadata: {
      streams: [
        { index: 0, kind: "video" },
        { index: 4, kind: "audio", sampleRate, channels },
      ],
    },
    streams: [{ index: 0 }, { index: 4, channelLayout }],
  };
}

function unsupported(reason, preset, streamIndex = 4) {
  return {
    code: "UNSUPPORTED_CAPABILITY",
    stage: "preparing",
    details: { reason, streamIndex, preset },
  };
}

test("audio source validation preserves supported rates and layouts", () => {
  for (const preset of presets) {
    for (const sampleRate of [44100, 48000]) {
      for (const [channels, channelLayout] of [
        [1, "mono"],
        [2, "stereo"],
      ]) {
        const input = source({ sampleRate, channels, channelLayout });
        const snapshot = structuredClone(input);
        const result = validateNativeAudioSource(input, preset);

        assert.deepEqual(result, {
          audioStreamIndex: 4,
          sampleRate,
          channels,
          channelLayout,
        });
        assert.equal(Object.isFrozen(result), true);
        assert.deepEqual(input, snapshot);
      }
    }
  }
});

test("audio source validation checks the explicitly selected stream", () => {
  const input = source({ sampleRate: 96000 });

  input.metadata.streams.push({
    index: 8,
    kind: "audio",
    sampleRate: 44100,
    channels: 2,
  });
  input.streams.push({ index: 8, channelLayout: "stereo" });

  for (const preset of presets) {
    assert.deepEqual(validateNativeAudioSource(input, preset, 8), {
      audioStreamIndex: 8,
      sampleRate: 44100,
      channels: 2,
      channelLayout: "stereo",
    });

    assert.throws(
      () => validateNativeAudioSource(input, preset),
      unsupported("UNSUPPORTED_AUDIO_SAMPLE_RATE", preset),
    );
  }
});

test("audio source validation requires technical details for the selected stream", () => {
  const input = source();
  input.streams = [{ index: 0 }];

  for (const preset of presets) {
    assert.throws(
      () => validateNativeAudioSource(input, preset),
      unsupported("MISSING_STREAM_DETAILS", preset),
    );
  }
});

test("audio source validation rejects unsupported or missing sample rates", () => {
  for (const preset of presets) {
    for (const sampleRate of [8000, 32000, 96000, undefined]) {
      const input = source();
      input.metadata.streams[1].sampleRate = sampleRate;

      assert.throws(
        () => validateNativeAudioSource(input, preset),
        unsupported("UNSUPPORTED_AUDIO_SAMPLE_RATE", preset),
      );
    }
  }
});

test("audio source validation rejects unknown and inconsistent layouts", () => {
  for (const preset of presets) {
    for (const [channels, channelLayout] of [
      [1, "stereo"],
      [2, "mono"],
      [6, "5.1"],
      [2, undefined],
      [undefined, "mono"],
    ]) {
      const input = source();
      input.metadata.streams[1].channels = channels;
      input.streams[1].channelLayout = channelLayout;

      assert.throws(
        () => validateNativeAudioSource(input, preset),
        unsupported("UNSUPPORTED_AUDIO_LAYOUT", preset),
      );
    }
  }
});

test("audio source validation rejects unrelated presets", () => {
  for (const preset of ["video-balanced-v1", "", undefined]) {
    assert.throws(() => validateNativeAudioSource(source(), preset), {
      code: "INVALID_OPTIONS",
      details: { reason: "INVALID_NATIVE_AUDIO_PRESET" },
    });
  }
});

function pcmWavSource(channels = 2, sampleRate = 48000) {
  return {
    metadata: {
      container: "wav",
      streams: [
        {
          index: 4,
          kind: "audio",
          codec: "pcm_s16le",
          sampleRate,
          channels,
        },
      ],
    },
    streams: [{ index: 4 }],
  };
}

test("PCM WAV sources accept implicit mono and stereo without mutating metadata", () => {
  for (const preset of presets) {
    for (const sampleRate of [44100, 48000]) {
      for (const [channels, channelLayout] of [
        [1, "mono"],
        [2, "stereo"],
      ]) {
        const input = pcmWavSource(channels, sampleRate);
        const before = structuredClone(input);

        assert.deepEqual(validateNativeAudioSource(input, preset, 4), {
          audioStreamIndex: 4,
          sampleRate,
          channels,
          channelLayout,
        });

        assert.deepEqual(input, before);
      }
    }
  }
});

test("implicit source layouts are limited to the supported PCM WAV profile", () => {
  for (const preset of presets) {
    for (const [container, codec] of [
      ["mp3", "mp3"],
      ["flac", "flac"],
      ["wav", "pcm_s24le"],
      ["wav", undefined],
      [undefined, "pcm_s16le"],
    ]) {
      const input = pcmWavSource();
      input.metadata.container = container;
      input.metadata.streams[0].codec = codec;

      assert.throws(
        () => validateNativeAudioSource(input, preset),
        unsupported("UNSUPPORTED_AUDIO_LAYOUT", preset),
      );
    }
  }
});

test("PCM WAV source inference never overrides explicit conflicts or multichannel layouts", () => {
  for (const preset of presets) {
    for (const [channels, channelLayout] of [
      [1, "stereo"],
      [2, "mono"],
      [2, "5.1"],
      [6, undefined],
    ]) {
      const input = pcmWavSource(channels);
      input.streams[0].channelLayout = channelLayout;

      assert.throws(
        () => validateNativeAudioSource(input, preset),
        unsupported("UNSUPPORTED_AUDIO_LAYOUT", preset),
      );
    }
  }
});

test("PCM WAV inference still requires matching stream details and supported sample rates", () => {
  for (const preset of presets) {
    const missingDetails = pcmWavSource();
    missingDetails.streams = [];

    assert.throws(
      () => validateNativeAudioSource(missingDetails, preset),
      unsupported("MISSING_STREAM_DETAILS", preset),
    );

    assert.throws(
      () => validateNativeAudioSource(pcmWavSource(2, 96000), preset),
      unsupported("UNSUPPORTED_AUDIO_SAMPLE_RATE", preset),
    );
  }
});
