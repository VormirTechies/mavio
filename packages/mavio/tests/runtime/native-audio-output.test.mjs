import assert from "node:assert/strict";
import test from "node:test";
import { validateNativeAudioOutput } from "../../dist/engines/native/audio-output.js";

const presets = ["audio-balanced-v1", "audio-pcm-v1"];

function fixture(preset = "audio-balanced-v1") {
  return {
    expected: {
      preset,
      sampleRate: 48000,
      channels: 2,
      channelLayout: "stereo",
    },
    output: {
      metadata: {
        container: preset === "audio-balanced-v1" ? "mp3" : "wav",
        durationSeconds: 2,
        sizeBytes: 4096,
        streams: [
          {
            index: 0,
            kind: "audio",
            codec: preset === "audio-balanced-v1" ? "mp3" : "pcm_s16le",
            sampleRate: 48000,
            channels: 2,
          },
        ],
      },
      streams: [{ index: 0, channelLayout: "stereo" }],
    },
  };
}

function rejects(output, expected, reason) {
  assert.throws(() => validateNativeAudioOutput(output, expected, "audio-output-test"), {
    code: "EXECUTION_FAILED",
    stage: "finalizing",
    jobId: "audio-output-test",
    details: { reason, preset: expected.preset },
  });
}

test("audio output accepts both presets with preserved rates and layouts", () => {
  for (const preset of presets) {
    for (const sampleRate of [44100, 48000]) {
      for (const [channels, channelLayout] of [
        [1, "mono"],
        [2, "stereo"],
      ]) {
        const { output, expected } = fixture(preset);

        Object.assign(expected, { sampleRate, channels, channelLayout });
        Object.assign(output.metadata.streams[0], { sampleRate, channels });
        output.streams[0].channelLayout = channelLayout;

        const before = structuredClone({ output, expected });

        validateNativeAudioOutput(output, expected);

        assert.deepEqual({ output, expected }, before);
      }
    }
  }
});

test("audio output requires the expected container", () => {
  for (const preset of presets) {
    for (const container of ["mp4", "matroska", undefined]) {
      const { output, expected } = fixture(preset);
      output.metadata.container = container;

      rejects(output, expected, "OUTPUT_CONTAINER_MISMATCH");
    }

    const { output, expected } = fixture(preset);
    output.metadata.container = preset === "audio-balanced-v1" ? "wav" : "mp3";

    rejects(output, expected, "OUTPUT_CONTAINER_MISMATCH");
  }
});

test("audio output requires the exact preset codec", () => {
  for (const preset of presets) {
    for (const codec of ["aac", "pcm_s24le", undefined]) {
      const { output, expected } = fixture(preset);
      output.metadata.streams[0].codec = codec;

      rejects(output, expected, "OUTPUT_AUDIO_CODEC_MISMATCH");
    }
  }
});

test("audio output requires exactly one audio stream", () => {
  for (const preset of presets) {
    for (const mode of ["empty", "video", "extra-audio", "subtitle"]) {
      const { output, expected } = fixture(preset);

      if (mode === "empty") {
        output.metadata.streams = [];
      } else if (mode === "video") {
        output.metadata.streams[0].kind = "video";
      } else {
        output.metadata.streams.push({
          index: 1,
          kind: mode === "extra-audio" ? "audio" : "subtitle",
        });
      }

      rejects(output, expected, "OUTPUT_STREAMS_MISMATCH");
    }
  }
});

test("audio output rejects changed or unverifiable audio profiles", () => {
  const changes = [
    (output) => {
      output.metadata.streams[0].sampleRate = 44100;
    },
    (output) => {
      output.metadata.streams[0].channels = 1;
    },
    (output) => {
      output.streams[0].channelLayout = "mono";
    },
    (output) => {
      output.streams[0].index = 7;
    },
    (output) => {
      output.streams = [];
    },
    (output) => {
      output.streams.push({ index: 1, channelLayout: "stereo" });
    },
  ];

  for (const preset of presets) {
    for (const change of changes) {
      const { output, expected } = fixture(preset);
      change(output);

      rejects(output, expected, "OUTPUT_AUDIO_PROFILE_MISMATCH");
    }
  }
});

test("audio output requires a finite positive duration", () => {
  for (const preset of presets) {
    for (const duration of [undefined, 0, -1, NaN, Infinity]) {
      const { output, expected } = fixture(preset);
      output.metadata.durationSeconds = duration;

      rejects(output, expected, "INVALID_OUTPUT_DURATION");
    }
  }
});

test("audio output requires a positive safe integer byte size", () => {
  for (const preset of presets) {
    for (const size of [undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const { output, expected } = fixture(preset);
      output.metadata.sizeBytes = size;

      rejects(output, expected, "INVALID_OUTPUT_SIZE");
    }
  }
});

test("PCM WAV accepts implicit mono and stereo layouts without changing probe data", () => {
  for (const [channels, channelLayout] of [
    [1, "mono"],
    [2, "stereo"],
  ]) {
    const { output, expected } = fixture("audio-pcm-v1");

    expected.channels = channels;
    expected.channelLayout = channelLayout;
    output.metadata.streams[0].channels = channels;
    delete output.streams[0].channelLayout;

    const before = structuredClone(output);

    validateNativeAudioOutput(output, expected);

    assert.deepEqual(output, before);
  }
});

test("MP3 still requires explicit matching layout metadata", () => {
  const { output, expected } = fixture("audio-balanced-v1");
  delete output.streams[0].channelLayout;

  rejects(output, expected, "OUTPUT_AUDIO_PROFILE_MISMATCH");
});

test("PCM WAV layout inference does not override conflicts or channel mismatches", () => {
  for (const [channels, layout] of [
    [2, "mono"],
    [2, "5.1"],
    [1, undefined],
    [6, undefined],
  ]) {
    const { output, expected } = fixture("audio-pcm-v1");

    output.metadata.streams[0].channels = channels;
    output.streams[0].channelLayout = layout;

    rejects(output, expected, "OUTPUT_AUDIO_PROFILE_MISMATCH");
  }
});
