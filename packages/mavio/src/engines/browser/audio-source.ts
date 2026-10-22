import { createMavioError } from "../../core/errors.js";
import { validateAudioSource, type AudioSource } from "../shared/audio-source.js";
import type { BrowserAudioPreset } from "./audio-encoding.js";
import type { BrowserInventory } from "./inventory.js";
import type { BrowserProbeDetails } from "./probe-details.js";

export type BrowserAudioSource = AudioSource;

export function validateBrowserAudioSource(
  source: BrowserProbeDetails,
  inventory: BrowserInventory,
  preset: BrowserAudioPreset,
  streamIndex?: number,
): BrowserAudioSource {
  const selected = validateAudioSource(source, preset, streamIndex);

  const audio = source.metadata.streams.find(
    (stream) => stream.index === selected.audioStreamIndex,
  )!;

  if (audio.codec === undefined || !inventory.decoders.includes(audio.codec)) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The browser core cannot decode the selected audio stream.",
      {
        stage: "preparing",
        details: {
          reason: "MISSING_SOURCE_DECODER",
          streamIndex: selected.audioStreamIndex,
          preset,
        },
      },
    );
  }

  return selected;
}
