import type { Transformation } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";

export interface NativeVideoDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Plans each resize in sequence.
 * The caller must first establish square pixels and normalized orientation.
 */
export function planNativeMp4Resize(
  source: NativeVideoDimensions,
  transformations: readonly Transformation[],
): readonly NativeVideoDimensions[] {
  const positiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

  if (!positiveInteger(source.width) || !positiveInteger(source.height)) {
    throw createMavioError("INVALID_MEDIA", "Resize requires valid source dimensions.", {
      stage: "preparing",
      operation: "resize",
      details: { reason: "INVALID_SOURCE_DIMENSIONS" },
    });
  }

  let width = BigInt(source.width);
  let height = BigInt(source.height);

  const steps: NativeVideoDimensions[] = [];

  for (const [operationIndex, transformation] of transformations.entries()) {
    if (transformation.type !== "resize") continue;

    const box = transformation.options;

    function invalidDimensions(): never {
      throw createMavioError(
        "INVALID_OPTIONS",
        "Resize dimensions cannot produce a valid aligned output.",
        {
          stage: "preparing",
          operation: "resize",
          details: { reason: "INVALID_DIMENSIONS", operationIndex },
        },
      );
    }

    if (!positiveInteger(box.width) || !positiveInteger(box.height)) {
      invalidDimensions();
    }

    const boxWidth = BigInt(box.width);
    const boxHeight = BigInt(box.height);

    // Each dimension is capped by the preceding logical result.
    const maxWidth = boxWidth < width ? boxWidth : width;
    const maxHeight = boxHeight < height ? boxHeight : height;

    let fittedWidth: bigint;
    let fittedHeight: bigint;

    // Compare ratios without floating-point rounding.
    if (maxWidth * height <= maxHeight * width) {
      fittedWidth = maxWidth;
      fittedHeight = (height * maxWidth) / width;
    } else {
      fittedHeight = maxHeight;
      fittedWidth = (width * maxHeight) / height;
    }

    // The current yuv420p encoding route requires even dimensions.
    fittedWidth -= fittedWidth % 2n;
    fittedHeight -= fittedHeight % 2n;

    if (fittedWidth === 0n || fittedHeight === 0n) {
      invalidDimensions();
    }

    width = fittedWidth;
    height = fittedHeight;

    steps.push(
      Object.freeze({
        width: Number(width),
        height: Number(height),
      }),
    );
  }

  return Object.freeze(steps);
}
