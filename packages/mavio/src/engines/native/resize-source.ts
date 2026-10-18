import { createMavioError } from "../../core/errors.js";
import { selectNativeMp4Streams } from "./mp4-streams.js";
import type { NativeProbeDetails } from "./probe-details.js";
import type { NativeVideoDimensions } from "./resize-dimensions.js";

export function validateNativeResizeSource(source: NativeProbeDetails): NativeVideoDimensions {
  const selected = selectNativeMp4Streams(source.metadata);
  const video = source.metadata.streams.find(
    (stream) => stream.index === selected.videoStreamIndex,
  )!;
  const details = source.streams.find((stream) => stream.index === selected.videoStreamIndex);

  function unsupported(reason: string): never {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The source is outside the initial native resize profile.",
      {
        stage: "preparing",
        operation: "resize",
        details: { reason, streamIndex: video.index },
      },
    );
  }

  if (
    details?.defaultOrientation !== true ||
    (video.rotationDegrees !== undefined && video.rotationDegrees !== 0)
  ) {
    unsupported("UNSUPPORTED_RESIZE_ORIENTATION");
  }

  if (details.sampleAspectRatio !== "1:1") {
    unsupported("UNSUPPORTED_RESIZE_SAMPLE_ASPECT_RATIO");
  }

  const { width, height } = video;

  if (
    width === undefined ||
    height === undefined ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw createMavioError("INVALID_MEDIA", "Resize requires valid source dimensions.", {
      stage: "preparing",
      operation: "resize",
      details: {
        reason: "INVALID_SOURCE_DIMENSIONS",
        streamIndex: video.index,
      },
    });
  }

  return Object.freeze({ width, height });
}
