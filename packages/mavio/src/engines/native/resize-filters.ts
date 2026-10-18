import type { Transformation } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import type { NativeInventory } from "./inventory.js";
import { planNativeMp4Resize, type NativeVideoDimensions } from "./resize-dimensions.js";

export interface NativeResizeFilters {
  readonly video: string;
  readonly dimensions: NativeVideoDimensions;
}

/**
 * Requires square-pixel source dimensions with normalized orientation.
 * Source-profile validation belongs to the caller.
 */
export function buildNativeResizeFilters(
  source: NativeVideoDimensions,
  transformations: readonly Transformation[],
  inventory: NativeInventory,
): NativeResizeFilters | undefined {
  if (!transformations.some((item) => item.type === "resize")) {
    return undefined;
  }

  const steps = planNativeMp4Resize(source, transformations);

  for (const filter of ["scale", "setsar"]) {
    if (!inventory.filters.includes(filter)) {
      throw createMavioError(
        "UNSUPPORTED_CAPABILITY",
        `The installed FFmpeg build lacks ${filter}.`,
        {
          stage: "preparing",
          operation: "resize",
          details: { reason: "MISSING_FILTER", filter },
        },
      );
    }
  }

  const video = steps
    .map(({ width, height }) => `scale=w=${width}:h=${height}:flags=lanczos,setsar=1`)
    .join(",");

  return Object.freeze({
    video,
    dimensions: steps[steps.length - 1]!,
  });
}
