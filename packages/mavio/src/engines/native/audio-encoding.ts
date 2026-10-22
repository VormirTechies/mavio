import { createMavioError } from "../../core/errors.js";
import { buildAudioEncoding, type AudioPreset } from "../shared/audio-encoding.js";
import type { NativeInventory } from "./inventory.js";

export type NativeAudioPreset = AudioPreset;

export function buildNativeAudioEncoding(
  preset: NativeAudioPreset,
  inventory: NativeInventory,
): readonly string[] {
  // Preserve the existing native error contract.
  if (preset !== "audio-balanced-v1" && preset !== "audio-pcm-v1") {
    throw createMavioError("INVALID_OPTIONS", "The native audio preset is invalid.", {
      details: {
        reason: "INVALID_NATIVE_AUDIO_PRESET",
      },
    });
  }

  return buildAudioEncoding(preset, inventory);
}
