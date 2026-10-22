import { createMavioError } from "../../core/errors.js";
import type { NativeTrimRange } from "./trim-range.js";

interface TrimFilterInventory {
  readonly filters: readonly string[];
}

export interface NativeTrimFilters {
  readonly inputArgs: readonly string[];
  readonly video: string;
  readonly audio?: string;
  readonly mp4OutputArgs: readonly string[];
}

export function buildNativeTrimFilters(
  range: NativeTrimRange,
  sourceOriginSeconds: number | undefined,
  hasAudio: boolean,
  inventory: TrimFilterInventory,
): NativeTrimFilters {
  function unsupported(reason: string): never {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The requested trim exceeds the currently supported native timing profile.",
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
    range.endSeconds <= range.startSeconds ||
    typeof hasAudio !== "boolean"
  ) {
    throw createMavioError("INVALID_OPTIONS", "Invalid native trim parameters.", {
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

    // Verify round-trip equality instead of silently rounding the request.
    if (!Number.isSafeInteger(value) || value / 1_000_000 !== seconds) {
      unsupported("UNSUPPORTED_TRIM_PRECISION");
    }

    return value;
  }

  const start = microseconds(range.startSeconds);
  const end = microseconds(range.endSeconds);

  const required = ["trim", "settb", "setpts", ...(hasAudio ? ["atrim", "asetpts"] : [])];

  for (const filter of required) {
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

  const selection = `start=${start}us:end=${end}us`;

  // Both streams subtract the same requested start time.
  // Do not independently reset each stream to its first retained timestamp.
  const rebase = `PTS-${start}/(1000000*TB)`;

  return Object.freeze({
    inputArgs: Object.freeze(["-copyts"]),
    mp4OutputArgs: Object.freeze([
      "-enc_time_base:v",
      "filter",
      "-video_track_timescale",
      "1000000",
      "-movie_timescale",
      "1000000",
      "-avoid_negative_ts",
      "disabled",
      "-use_editlist",
      "1",
    ]),
    video: `trim=${selection},settb=expr=1/1000000,setpts=${rebase}`,
    ...(hasAudio ? { audio: `atrim=${selection},asetpts=${rebase}` } : {}),
  });
}
