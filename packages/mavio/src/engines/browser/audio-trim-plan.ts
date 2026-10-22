import type { Transformation } from "../../contracts.js";
import { buildAudioTrimFilters } from "../shared/audio-trim-filters.js";
import { resolveNativeTrimRange, type NativeTrimRange } from "../shared/trim-range.js";
import type { BrowserInventory } from "./inventory.js";

export interface BrowserAudioTrimPlan {
  readonly range: NativeTrimRange;
  readonly inputArgs: readonly string[];
  readonly audio: string;
}

/**
 * Resolves consecutive trims against the original source timeline.
 * Actual sample selection is checked separately before encoding.
 */
export function buildBrowserAudioTrimPlan(
  transformations: readonly Transformation[],
  sourceDurationSeconds: number | undefined,
  sourceOriginSeconds: number | undefined,
  inventory: BrowserInventory,
): BrowserAudioTrimPlan | undefined {
  const range = resolveNativeTrimRange(transformations, sourceDurationSeconds);

  if (range === undefined) return undefined;

  const filters = buildAudioTrimFilters(range, sourceOriginSeconds, inventory);

  return Object.freeze({
    range,
    inputArgs: filters.inputArgs,
    audio: filters.audio,
  });
}
