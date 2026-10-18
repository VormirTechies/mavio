import { createMavioError } from "../../core/errors.js";
import type { NativeInventory } from "./inventory.js";

export type NativeMp4Preset = "video-balanced-v1" | "video-small-v1";

export function buildNativeMp4Encoding(
  preset: NativeMp4Preset,
  inventory: NativeInventory,
  hasAudio: boolean,
): readonly string[] {
  if (preset !== "video-balanced-v1" && preset !== "video-small-v1") {
    throw createMavioError("INVALID_OPTIONS", "Unsupported native MP4 preset.", {
      stage: "preparing",
      details: { reason: "INVALID_NATIVE_MP4_PRESET" },
    });
  }

  if (typeof hasAudio !== "boolean") {
    throw createMavioError(
      "INVALID_OPTIONS",
      "Audio presence must be explicitly resolved before encoding.",
      { stage: "preparing" },
    );
  }

  function requireComponent(available: readonly string[], component: string, reason: string): void {
    if (!available.includes(component)) {
      throw createMavioError(
        "UNSUPPORTED_CAPABILITY",
        `The installed FFmpeg build lacks ${component}.`,
        {
          stage: "preparing",
          details: { reason, component, preset },
        },
      );
    }
  }

  requireComponent(inventory.muxers, "mp4", "MISSING_MUXER");
  requireComponent(inventory.encoders, "libx264", "MISSING_ENCODER");

  if (hasAudio) {
    requireComponent(inventory.encoders, "aac", "MISSING_ENCODER");
  }

  const small = preset === "video-small-v1";

  const args = [
    "-c:v",
    "libx264",
    "-crf",
    small ? "28" : "23",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "+yuv420p",
    "-fps_mode:v",
    "passthrough",
  ];

  if (hasAudio) {
    args.push("-c:a", "aac", "-b:a", small ? "96k" : "128k");
  } else {
    args.push("-an");
  }

  args.push("-movflags", "+faststart", "-f", "mp4");

  return Object.freeze(args);
}
