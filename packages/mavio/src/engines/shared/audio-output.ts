import { createMavioError } from "../../core/errors.js";
import type { AudioPreset } from "./audio-encoding.js";
import type { AudioSource } from "./audio-source.js";
import type { ProbeDetails } from "./probe-details.js";

export interface AudioOutputExpectation {
  readonly preset: AudioPreset;
  readonly sampleRate: AudioSource["sampleRate"];
  readonly channels: AudioSource["channels"];
  readonly channelLayout: AudioSource["channelLayout"];
}

/** Accepts parsed probe details and a validated encoding expectation. */
export function validateAudioOutput(
  output: ProbeDetails,
  expected: AudioOutputExpectation,
  jobId?: string,
): void {
  function invalid(reason: string): never {
    throw createMavioError(
      "EXECUTION_FAILED",
      "The encoded audio does not match the expected output.",
      {
        stage: "finalizing",
        jobId,
        details: { reason, preset: expected.preset },
      },
    );
  }

  const format = expected.preset === "audio-balanced-v1" ? "mp3" : "wav";
  const codec = expected.preset === "audio-balanced-v1" ? "mp3" : "pcm_s16le";

  const { metadata } = output;

  if (metadata.container !== format) {
    invalid("OUTPUT_CONTAINER_MISMATCH");
  }

  if (
    metadata.durationSeconds === undefined ||
    !Number.isFinite(metadata.durationSeconds) ||
    metadata.durationSeconds <= 0
  ) {
    invalid("INVALID_OUTPUT_DURATION");
  }

  if (
    metadata.sizeBytes === undefined ||
    !Number.isSafeInteger(metadata.sizeBytes) ||
    metadata.sizeBytes <= 0
  ) {
    invalid("INVALID_OUTPUT_SIZE");
  }

  if (metadata.streams.length !== 1 || metadata.streams[0]?.kind !== "audio") {
    invalid("OUTPUT_STREAMS_MISMATCH");
  }

  const audio = metadata.streams[0]!;

  if (audio.codec !== codec) {
    invalid("OUTPUT_AUDIO_CODEC_MISMATCH");
  }

  const details = output.streams[0];

  // Standard mono/stereo PCM WAV may omit explicit layout metadata.
  // Apply this convention only to the validated PCM WAV output route.
  const implicitPcmLayout =
    expected.preset === "audio-pcm-v1" &&
    details !== undefined &&
    details.channelLayout === undefined
      ? audio.channels === 1
        ? "mono"
        : audio.channels === 2
          ? "stereo"
          : undefined
      : undefined;

  const actualLayout = details?.channelLayout ?? implicitPcmLayout;

  if (
    output.streams.length !== 1 ||
    details === undefined ||
    details.index !== audio.index ||
    audio.sampleRate !== expected.sampleRate ||
    audio.channels !== expected.channels ||
    actualLayout !== expected.channelLayout
  ) {
    invalid("OUTPUT_AUDIO_PROFILE_MISMATCH");
  }
}
