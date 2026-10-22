import type { Transformation } from "../../contracts.js";
import { buildNativeTrimFilters } from "../shared/trim-filters.js";
import { resolveNativeTrimRange } from "../shared/trim-range.js";
import type { BrowserInventory } from "./inventory.js";

export function buildBrowserTrimPlan(
  transformations: readonly Transformation[],
  sourceDurationSeconds: number | undefined,
  sourceOriginSeconds: number | undefined,
  hasAudio: boolean,
  inventory: BrowserInventory,
) {
  const range = resolveNativeTrimRange(transformations, sourceDurationSeconds);

  if (range === undefined) return undefined;

  const filters = buildNativeTrimFilters(range, sourceOriginSeconds, hasAudio, inventory);

  // Use the same microsecond time base as the settb filter.
  // An explicit rational avoids depending on the newer "filter" spelling.
  const mp4OutputArgs = filters.mp4OutputArgs.map((value, index, args) =>
    index > 0 && args[index - 1] === "-enc_time_base:v" ? "1:1000000" : value,
  );

  return Object.freeze({
    range,
    inputArgs: filters.inputArgs,
    video: filters.video,
    audio: filters.audio,
    mp4OutputArgs: Object.freeze(mp4OutputArgs),
  });
}
