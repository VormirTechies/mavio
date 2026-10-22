import { createMavioError } from "../../core/errors.js";
import { buildThumbnailEncoding, type ThumbnailPreset } from "../shared/thumbnail-encoding.js";
import type { NativeInventory } from "./inventory.js";

export type NativeThumbnailPreset = ThumbnailPreset;

export function buildNativeThumbnailEncoding(
  preset: NativeThumbnailPreset,
  inventory: NativeInventory,
): readonly string[] {
  if (preset !== "jpeg-balanced-v1" && preset !== "png-lossless-v1") {
    throw createMavioError("INVALID_OPTIONS", "The native thumbnail preset is invalid.", {
      details: { reason: "INVALID_NATIVE_THUMBNAIL_PRESET" },
    });
  }

  return buildThumbnailEncoding(preset, inventory);
}
