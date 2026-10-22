import type { Transformation } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import { planMp4Resize, type VideoDimensions } from "../shared/resize-dimensions.js";
import type { BrowserInventory } from "./inventory.js";

export interface BrowserResizePlan {
  readonly video: string;
  readonly dimensions: VideoDimensions;
}

/**
 * Source orientation and square pixels must be validated
 * before this plan is used for execution.
 */
export function buildBrowserResizePlan(
  source: VideoDimensions,
  transformations: readonly Transformation[],
  inventory: Pick<BrowserInventory, "filters">,
): BrowserResizePlan | undefined {
  if (!transformations.some((transformation) => transformation.type === "resize")) {
    return undefined;
  }

  const steps = planMp4Resize(source, transformations);

  for (const filter of ["scale", "setsar"]) {
    if (!inventory.filters.includes(filter)) {
      throw createMavioError(
        "UNSUPPORTED_CAPABILITY",
        `The browser core lacks the ${filter} filter.`,
        {
          stage: "preparing",
          operation: "resize",
          details: {
            reason: "MISSING_FILTER",
            filter,
          },
        },
      );
    }
  }

  return Object.freeze({
    video: steps
      .map(({ width, height }) => `scale=w=${width}:h=${height}:flags=lanczos,setsar=1`)
      .join(","),
    dimensions: steps[steps.length - 1]!,
  });
}
