import type { Transformation } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import type { ThumbnailPreset } from "./thumbnail-encoding.js";

export function buildThumbnailResize(
  source: { width: number; height: number },
  transformations: readonly Transformation[],
  preset: ThumbnailPreset,
  inventory: { readonly filters: readonly string[] },
): {
  readonly video: string;
  readonly dimensions: { readonly width: number; readonly height: number };
} {
  const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

  if (!positive(source.width) || !positive(source.height)) {
    throw createMavioError("INVALID_MEDIA", "Thumbnail resize requires valid source dimensions.", {
      stage: "preparing",
      operation: "resize",
      details: { reason: "INVALID_SOURCE_DIMENSIONS" },
    });
  }

  const resizing = transformations.some((item) => item.type === "resize");

  if (resizing) {
    for (const filter of ["scale", "setsar"]) {
      if (!inventory.filters.includes(filter)) {
        throw createMavioError("UNSUPPORTED_CAPABILITY", `Missing ${filter} filter.`, {
          stage: "preparing",
          operation: "resize",
          details: { reason: "MISSING_FILTER", filter },
        });
      }
    }
  }

  let width = BigInt(source.width);
  let height = BigInt(source.height);
  const alignment = preset === "jpeg-balanced-v1" ? 2n : 1n;
  const filters: string[] = [];

  for (const [operationIndex, item] of transformations.entries()) {
    if (item.type !== "resize") continue;

    function invalid(): never {
      throw createMavioError(
        "INVALID_OPTIONS",
        "Resize cannot produce valid thumbnail dimensions.",
        {
          stage: "preparing",
          operation: "resize",
          details: { reason: "INVALID_DIMENSIONS", operationIndex },
        },
      );
    }

    if (!positive(item.options.width) || !positive(item.options.height)) invalid();

    const boxWidth = BigInt(item.options.width);
    const boxHeight = BigInt(item.options.height);
    const maxWidth = boxWidth < width ? boxWidth : width;
    const maxHeight = boxHeight < height ? boxHeight : height;

    let nextWidth: bigint;
    let nextHeight: bigint;

    if (maxWidth * height <= maxHeight * width) {
      nextWidth = maxWidth;
      nextHeight = (height * maxWidth) / width;
    } else {
      nextHeight = maxHeight;
      nextWidth = (width * maxHeight) / height;
    }

    nextWidth -= nextWidth % alignment;
    nextHeight -= nextHeight % alignment;

    if (nextWidth === 0n || nextHeight === 0n) invalid();

    width = nextWidth;
    height = nextHeight;

    filters.push(`scale=w=${width}:h=${height}:flags=lanczos`, "setsar=1");
  }

  return Object.freeze({
    video: filters.join(","),
    dimensions: Object.freeze({
      width: Number(width),
      height: Number(height),
    }),
  });
}
