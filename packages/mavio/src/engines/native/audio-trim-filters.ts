import { createMavioError } from "../../core/errors.js";
import type { NativeInventory } from "./inventory.js";
import type { NativeTrimRange } from "./trim-range.js";

export interface NativeAudioTrimFilters {
  readonly inputArgs: readonly string[];
  readonly audio: string;
}

export function buildNativeAudioTrimFilters(
  range: NativeTrimRange,
  sourceOriginSeconds: number | undefined,
  inventory: NativeInventory,
): NativeAudioTrimFilters {
  function unsupported(reason: string): never {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The requested audio trim exceeds the supported timing profile.",
      {
        stage: "preparing",
        operation: "trim",
        details: { reason },
      },
    );
  }

  if (
    !Number.isFinite(range.startSeconds) ||
    !Number.isFinite(range.endSeconds) ||
    range.startSeconds < 0 ||
    range.endSeconds <= range.startSeconds
  ) {
    throw createMavioError("INVALID_OPTIONS", "Invalid native audio trim interval.", {
      stage: "preparing",
      operation: "trim",
      details: { reason: "INVALID_TRIM_RANGE" },
    });
  }

  if (sourceOriginSeconds !== 0) {
    unsupported("UNSUPPORTED_TIME_ORIGIN");
  }

  function microseconds(seconds: number): number {
    const value = Math.round(seconds * 1_000_000);

    if (!Number.isSafeInteger(value) || value / 1_000_000 !== seconds) {
      unsupported("UNSUPPORTED_TRIM_PRECISION");
    }

    return value;
  }

  const start = microseconds(range.startSeconds);
  const end = microseconds(range.endSeconds);

  for (const filter of ["atrim", "asetpts"]) {
    if (!inventory.filters.includes(filter)) {
      throw createMavioError(
        "UNSUPPORTED_CAPABILITY",
        `The installed FFmpeg build lacks ${filter}.`,
        {
          stage: "preparing",
          operation: "trim",
          details: { reason: "MISSING_FILTER", filter },
        },
      );
    }
  }

  return Object.freeze({
    inputArgs: Object.freeze(["-copyts"]),
    audio: `atrim=start=${start}us:end=${end}us,` + `asetpts=PTS-${start}/(1000000*TB)`,
  });
}
