import { createMavioError } from "../../core/errors.js";
import type { NativeInventory } from "./inventory.js";
import type { NativeThumbnailTime } from "./thumbnail-time.js";

export interface NativeThumbnailFilters {
  readonly inputArgs: readonly string[];
  readonly video: string;
}

export function buildNativeThumbnailFilters(
  time: NativeThumbnailTime,
  sourceOriginSeconds: number | undefined,
  inventory: NativeInventory,
): NativeThumbnailFilters {
  function unsupported(reason: string): never {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The thumbnail request exceeds the supported native timing profile.",
      {
        stage: "preparing",
        operation: "thumbnail",
        details: { reason },
      },
    );
  }

  const { sourceAtSeconds, sourceEndSeconds } = time;

  if (
    !Number.isFinite(sourceAtSeconds) ||
    !Number.isFinite(sourceEndSeconds) ||
    sourceAtSeconds < 0 ||
    sourceEndSeconds <= sourceAtSeconds
  ) {
    throw createMavioError("INVALID_OPTIONS", "Invalid native thumbnail selection interval.", {
      stage: "preparing",
      operation: "thumbnail",
      details: { reason: "INVALID_THUMBNAIL_INTERVAL" },
    });
  }

  if (sourceOriginSeconds !== 0) {
    unsupported("UNSUPPORTED_TIME_ORIGIN");
  }

  function microseconds(seconds: number): number {
    const value = Math.round(seconds * 1_000_000);

    if (!Number.isSafeInteger(value) || value / 1_000_000 !== seconds) {
      unsupported("UNSUPPORTED_THUMBNAIL_PRECISION");
    }

    return value;
  }

  const start = microseconds(sourceAtSeconds);
  const end = microseconds(sourceEndSeconds);

  for (const filter of ["trim", "setpts"]) {
    if (!inventory.filters.includes(filter)) {
      throw createMavioError(
        "UNSUPPORTED_CAPABILITY",
        `The installed FFmpeg build lacks ${filter}.`,
        {
          stage: "preparing",
          operation: "thumbnail",
          details: { reason: "MISSING_FILTER", filter },
        },
      );
    }
  }

  return Object.freeze({
    inputArgs: Object.freeze(["-copyts"]),
    video: `trim=start=${start}us:end=${end}us,setpts=PTS-STARTPTS`,
  });
}
