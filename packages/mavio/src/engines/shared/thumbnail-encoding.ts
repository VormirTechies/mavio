import { createMavioError } from "../../core/errors.js";

export type ThumbnailPreset = "jpeg-balanced-v1" | "png-lossless-v1";

interface ThumbnailInventory {
  readonly encoders: readonly string[];
  readonly muxers: readonly string[];
}

export function buildThumbnailEncoding(
  preset: ThumbnailPreset,
  inventory: ThumbnailInventory,
): readonly string[] {
  if (preset !== "jpeg-balanced-v1" && preset !== "png-lossless-v1") {
    throw createMavioError("INVALID_OPTIONS", "The thumbnail preset is invalid.", {
      details: { reason: "INVALID_THUMBNAIL_PRESET" },
    });
  }

  const encoder = preset === "jpeg-balanced-v1" ? "mjpeg" : "png";

  if (!inventory.muxers.includes("image2pipe")) {
    throw createMavioError("UNSUPPORTED_CAPABILITY", "The required image muxer is unavailable.", {
      stage: "preparing",
      details: {
        reason: "MISSING_MUXER",
        component: "image2pipe",
        preset,
      },
    });
  }

  if (!inventory.encoders.includes(encoder)) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The required thumbnail encoder is unavailable.",
      {
        stage: "preparing",
        details: {
          reason: "MISSING_ENCODER",
          component: encoder,
          preset,
        },
      },
    );
  }

  return Object.freeze([
    "-c:v",
    encoder,
    ...(preset === "jpeg-balanced-v1"
      ? ["-q:v", "3", "-pix_fmt", "yuvj420p"]
      : ["-pix_fmt", "rgb24", "-compression_level", "6"]),
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
  ]);
}
