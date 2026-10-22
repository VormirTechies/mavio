import { createMavioError } from "../../core/errors.js";
import { validateThumbnailSource, type ThumbnailSource } from "../shared/thumbnail-source.js";
import type { BrowserInventory } from "./inventory.js";
import type { BrowserProbeDetails } from "./probe-details.js";

export type BrowserThumbnailSource = ThumbnailSource;

export function validateBrowserThumbnailSource(
  source: BrowserProbeDetails,
  inventory: BrowserInventory,
): BrowserThumbnailSource {
  const selected = validateThumbnailSource(source);

  const video = source.metadata.streams.find(
    (stream) => stream.index === selected.videoStreamIndex,
  )!;

  if (video.codec === undefined || !inventory.decoders.includes(video.codec)) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The browser core cannot decode the selected thumbnail source.",
      {
        stage: "preparing",
        operation: "thumbnail",
        details: {
          reason: "MISSING_SOURCE_DECODER",
          streamIndex: selected.videoStreamIndex,
        },
      },
    );
  }

  return selected;
}
