import { createMavioError } from "../../core/errors.js";
import { validateAudioSource, type AudioSource } from "../shared/audio-source.js";
import type { NativeAudioPreset } from "./audio-encoding.js";
import type { NativeProbeDetails } from "./probe-details.js";

export type NativeAudioSource = AudioSource;

export function validateNativeAudioSource(
  source: NativeProbeDetails,
  preset: NativeAudioPreset,
  streamIndex?: number,
): NativeAudioSource {
  // Preserve the existing native error contract.
  if (preset !== "audio-balanced-v1" && preset !== "audio-pcm-v1") {
    throw createMavioError("INVALID_OPTIONS", "The native audio preset is invalid.", {
      details: {
        reason: "INVALID_NATIVE_AUDIO_PRESET",
      },
    });
  }

  return validateAudioSource(source, preset, streamIndex);
}
