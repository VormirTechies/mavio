import type { ErrorCode, Transformation } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import { resolveNativeTrimRange } from "./trim-range.js";

export interface NativeThumbnailTime {
  readonly sourceAtSeconds: number;
  readonly sourceEndSeconds: number;
}

export function resolveNativeThumbnailTime(
  transformations: readonly Transformation[],
  sourceDurationSeconds: number | undefined,
  at: number,
): NativeThumbnailTime {
  function fail(code: ErrorCode, reason: string, message: string): never {
    throw createMavioError(code, message, {
      stage: "preparing",
      operation: "thumbnail",
      details: { reason },
    });
  }

  if (!Number.isFinite(at) || at < 0) {
    fail(
      "INVALID_OPTIONS",
      "INVALID_THUMBNAIL_TIME",
      "Thumbnail time must be a finite non-negative number.",
    );
  }

  if (
    sourceDurationSeconds === undefined ||
    !Number.isFinite(sourceDurationSeconds) ||
    sourceDurationSeconds < 0
  ) {
    fail(
      "INVALID_MEDIA",
      "UNKNOWN_DURATION",
      "Thumbnail creation requires a known source duration.",
    );
  }

  for (const transformation of transformations) {
    if (transformation.type !== "trim" && transformation.type !== "resize") {
      fail(
        "INVALID_OPTIONS",
        "INVALID_THUMBNAIL_TRANSFORMATION",
        "Thumbnail creation accepts only preceding trim and resize operations.",
      );
    }
  }

  // This validates every trim against its preceding logical timeline.
  const range = resolveNativeTrimRange(transformations, sourceDurationSeconds);

  let logicalDuration = sourceDurationSeconds;

  for (const transformation of transformations) {
    if (transformation.type === "trim") {
      logicalDuration = transformation.options.end - transformation.options.start;
    }
  }

  if (at >= logicalDuration) {
    fail(
      "INVALID_OPTIONS",
      "OUT_OF_RANGE",
      "Thumbnail time must be earlier than the transformed duration.",
    );
  }

  const start = range?.startSeconds ?? 0;
  const end = range?.endSeconds ?? sourceDurationSeconds;
  const sourceAtSeconds = start + at;

  if (
    !Number.isFinite(sourceAtSeconds) ||
    sourceAtSeconds < start ||
    sourceAtSeconds >= end ||
    (at > 0 && sourceAtSeconds === start)
  ) {
    fail(
      "UNSUPPORTED_CAPABILITY",
      "TIMELINE_PRECISION_LIMIT",
      "The thumbnail time cannot be represented reliably.",
    );
  }

  return Object.freeze({
    sourceAtSeconds,
    sourceEndSeconds: end,
  });
}
