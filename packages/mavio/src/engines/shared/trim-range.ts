import type { Transformation } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";

export interface NativeTrimRange {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export function resolveNativeTrimRange(
  transformations: readonly Transformation[],
  sourceDurationSeconds: number | undefined,
): NativeTrimRange | undefined {
  let offset = 0;
  let duration = sourceDurationSeconds;
  let result: NativeTrimRange | undefined;

  for (const [operationIndex, transformation] of transformations.entries()) {
    if (transformation.type !== "trim") continue;

    const { start, end } = transformation.options;

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw createMavioError("INVALID_OPTIONS", "Trim requires a finite, non-empty interval.", {
        stage: "preparing",
        operation: "trim",
        details: { reason: "INVALID_TRIM_RANGE", operationIndex },
      });
    }

    if (duration === undefined || !Number.isFinite(duration) || duration < 0) {
      throw createMavioError("INVALID_MEDIA", "Trim requires a known media duration.", {
        stage: "preparing",
        operation: "trim",
        details: { reason: "UNKNOWN_DURATION", operationIndex },
      });
    }

    if (end > duration) {
      throw createMavioError("INVALID_OPTIONS", "Trim exceeds the current logical duration.", {
        stage: "preparing",
        operation: "trim",
        details: { reason: "OUT_OF_RANGE", operationIndex },
      });
    }

    const absoluteStart = offset + start;
    const absoluteEnd = offset + end;

    if (
      !Number.isFinite(absoluteStart) ||
      !Number.isFinite(absoluteEnd) ||
      absoluteEnd <= absoluteStart
    ) {
      throw createMavioError(
        "UNSUPPORTED_CAPABILITY",
        "The trim interval cannot be represented reliably.",
        {
          stage: "preparing",
          operation: "trim",
          details: { reason: "TIMELINE_PRECISION_LIMIT", operationIndex },
        },
      );
    }

    result = Object.freeze({
      startSeconds: absoluteStart,
      endSeconds: absoluteEnd,
    });

    offset = absoluteStart;
    duration = end - start;
  }

  return result;
}
