import { createMavioError } from "../../core/errors.js";

export type AudioPreset = "audio-balanced-v1" | "audio-pcm-v1";

interface AudioEncodingInventory {
  readonly encoders: readonly string[];
  readonly muxers: readonly string[];
}

export function buildAudioEncoding(
  preset: AudioPreset,
  inventory: AudioEncodingInventory,
): readonly string[] {
  if (preset !== "audio-balanced-v1" && preset !== "audio-pcm-v1") {
    throw createMavioError("INVALID_OPTIONS", "The audio preset is invalid.", {
      details: {
        reason: "INVALID_AUDIO_PRESET",
      },
    });
  }

  const format = preset === "audio-balanced-v1" ? "mp3" : "wav";

  const encoder = preset === "audio-balanced-v1" ? "libmp3lame" : "pcm_s16le";

  if (!inventory.muxers.includes(format)) {
    throw createMavioError("UNSUPPORTED_CAPABILITY", "The required audio muxer is unavailable.", {
      stage: "preparing",
      details: {
        reason: "MISSING_MUXER",
        component: format,
        preset,
      },
    });
  }

  if (!inventory.encoders.includes(encoder)) {
    throw createMavioError("UNSUPPORTED_CAPABILITY", "The required audio encoder is unavailable.", {
      stage: "preparing",
      details: {
        reason: "MISSING_ENCODER",
        component: encoder,
        preset,
      },
    });
  }

  const args = ["-c:a", encoder];

  if (preset === "audio-balanced-v1") {
    args.push("-b:a", "128k");
  }

  args.push("-f", format);

  return Object.freeze(args);
}
