import { createMavioError } from "../../core/errors.js";
import { buildThumbnailEncoding, type ThumbnailPreset } from "../shared/thumbnail-encoding.js";
import type { BrowserInventory } from "./inventory.js";

export type BrowserThumbnailPreset = ThumbnailPreset;

export function buildBrowserThumbnailEncoding(
  preset: BrowserThumbnailPreset,
  inventory: BrowserInventory,
): readonly string[] {
  if (preset !== "jpeg-balanced-v1" && preset !== "png-lossless-v1") {
    throw createMavioError("INVALID_OPTIONS", "The browser thumbnail preset is invalid.", {
      stage: "preparing",
      details: { reason: "INVALID_BROWSER_THUMBNAIL_PRESET" },
    });
  }

  return Object.freeze([...buildThumbnailEncoding(preset, inventory), "-threads:v", "1"]);
}
