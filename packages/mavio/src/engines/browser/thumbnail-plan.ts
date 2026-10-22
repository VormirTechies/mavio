import type { Transformation } from "../../contracts.js";
import { buildThumbnailFilters } from "../shared/thumbnail-filters.js";
import { resolveThumbnailTime } from "../shared/thumbnail-time.js";
import type { BrowserInventory } from "./inventory.js";
import type { BrowserProbeDetails } from "./probe-details.js";
import { validateBrowserThumbnailSource } from "./thumbnail-source.js";

/**
 * Plans selection of the first decoded frame at or after the requested
 * source time, bounded by the transformed clip's end.
 * Actual frame availability is checked during execution.
 */
export function buildBrowserThumbnailPlan(
  source: BrowserProbeDetails,
  transformations: readonly Transformation[],
  at: number,
  inventory: BrowserInventory,
) {
  const selected = validateBrowserThumbnailSource(source, inventory);

  const time = resolveThumbnailTime(transformations, source.metadata.durationSeconds, at);

  const filters = buildThumbnailFilters(time, source.formatStartTimeSeconds, inventory);

  return Object.freeze({
    source: selected,
    time,
    inputArgs: filters.inputArgs,
    video: filters.video,
  });
}
