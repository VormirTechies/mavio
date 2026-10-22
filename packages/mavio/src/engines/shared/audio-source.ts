import type { MediaMetadata as MavioMediaMetadata } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import type { AudioPreset } from "./audio-encoding.js";
import type { ProbeDetails } from "./probe-details.js";

export interface AudioStreamSelection {
  readonly audioStreamIndex: number;
}

export interface AudioSource {
  readonly audioStreamIndex: number;
  readonly sampleRate: 44100 | 48000;
  readonly channels: 1 | 2;
  readonly channelLayout: "mono" | "stereo";
}

export function selectAudioStream(
  source: MavioMediaMetadata,
  streamIndex?: number,
): AudioStreamSelection {
  function invalidIndex(): never {
    throw createMavioError(
      "INVALID_OPTIONS",
      "The requested stream index must identify a source audio stream.",
      {
        stage: "preparing",
        details: {
          reason: "INVALID_STREAM_INDEX",
        },
      },
    );
  }

  if (streamIndex !== undefined && (!Number.isSafeInteger(streamIndex) || streamIndex < 0)) {
    invalidIndex();
  }

  const audio =
    streamIndex === undefined
      ? source.streams.find((stream) => stream.kind === "audio")
      : source.streams.find((stream) => stream.index === streamIndex);

  if (streamIndex !== undefined && audio?.kind !== "audio") {
    invalidIndex();
  }

  if (audio === undefined) {
    throw createMavioError("INVALID_MEDIA", "The audio preset requires an audio stream.", {
      stage: "preparing",
      details: {
        reason: "MISSING_AUDIO",
      },
    });
  }

  return Object.freeze({
    audioStreamIndex: audio.index,
  });
}

export function validateAudioSource(
  source: ProbeDetails,
  preset: AudioPreset,
  streamIndex?: number,
): AudioSource {
  if (preset !== "audio-balanced-v1" && preset !== "audio-pcm-v1") {
    throw createMavioError("INVALID_OPTIONS", "The audio preset is invalid.", {
      details: {
        reason: "INVALID_AUDIO_PRESET",
      },
    });
  }

  const selected = selectAudioStream(source.metadata, streamIndex);

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

  // Infer standard mono/stereo layout only for PCM WAV.
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
      ? {
          channels: 1 as const,
          channelLayout: "mono" as const,
        }
      : audio.channels === 2 && channelLayout === "stereo"
        ? {
            channels: 2 as const,
            channelLayout: "stereo" as const,
          }
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
