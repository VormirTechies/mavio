import { createMavioError } from "../../core/errors.js";
import { buildAudioEncoding, type AudioPreset } from "../shared/audio-encoding.js";
import type { BrowserInventory } from "./inventory.js";

export type BrowserAudioPreset = AudioPreset;

export function buildBrowserAudioEncoding(
  preset: BrowserAudioPreset,
  inventory: BrowserInventory,
): readonly string[] {
  if (preset !== "audio-balanced-v1" && preset !== "audio-pcm-v1") {
    throw createMavioError("INVALID_OPTIONS", "The browser audio preset is invalid.", {
      stage: "preparing",
      details: {
        reason: "INVALID_BROWSER_AUDIO_PRESET",
      },
    });
  }

  return Object.freeze([...buildAudioEncoding(preset, inventory), "-threads:a", "1"]);
}
