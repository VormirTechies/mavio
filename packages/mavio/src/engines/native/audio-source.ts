import { createMavioError } from "../../core/errors.js";
import type { NativeAudioPreset } from "./audio-encoding.js";
import { selectNativeAudioStream } from "./audio-stream.js";
import type { NativeProbeDetails } from "./probe-details.js";

export interface NativeAudioSource {
  readonly audioStreamIndex: number;
  readonly sampleRate: 44100 | 48000;
  readonly channels: 1 | 2;
  readonly channelLayout: "mono" | "stereo";
}

export function validateNativeAudioSource(
  source: NativeProbeDetails,
  preset: NativeAudioPreset,
  streamIndex?: number,
): NativeAudioSource {
  if (preset !== "audio-balanced-v1" && preset !== "audio-pcm-v1") {
    throw createMavioError("INVALID_OPTIONS", "The native audio preset is invalid.", {
      details: { reason: "INVALID_NATIVE_AUDIO_PRESET" },
    });
  }

  const selected = selectNativeAudioStream(source.metadata, streamIndex);

  function unsupported(reason: string): never {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The source is outside the currently supported audio encoding profile.",
      {
        stage: "preparing",
        details: {
          reason,
          streamIndex: selected.audioStreamIndex,
          preset,
        },
      },
    );
  }

  const audio = source.metadata.streams.find(
    (stream) => stream.index === selected.audioStreamIndex && stream.kind === "audio",
  );
  const details = source.streams.find((stream) => stream.index === selected.audioStreamIndex);

  if (audio === undefined || details === undefined) {
    unsupported("MISSING_STREAM_DETAILS");
  }

  const sampleRate = audio.sampleRate;

  if (sampleRate !== 44100 && sampleRate !== 48000) {
    unsupported("UNSUPPORTED_AUDIO_SAMPLE_RATE");
  }

  // Apply the standard mono/stereo convention only to PCM WAV
  // when the selected stream has no explicit layout metadata.
  const implicitPcmLayout =
    source.metadata.container === "wav" &&
    audio.codec === "pcm_s16le" &&
    details.channelLayout === undefined
      ? audio.channels === 1
        ? "mono"
        : audio.channels === 2
          ? "stereo"
          : undefined
      : undefined;

  const channelLayout = details.channelLayout ?? implicitPcmLayout;

  const layout =
    audio.channels === 1 && channelLayout === "mono"
      ? { channels: 1 as const, channelLayout: "mono" as const }
      : audio.channels === 2 && channelLayout === "stereo"
        ? { channels: 2 as const, channelLayout: "stereo" as const }
        : undefined;

  if (layout === undefined) {
    unsupported("UNSUPPORTED_AUDIO_LAYOUT");
  }

  return Object.freeze({
    audioStreamIndex: selected.audioStreamIndex,
    sampleRate,
    ...layout,
  });
}
