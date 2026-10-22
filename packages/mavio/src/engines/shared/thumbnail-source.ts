import { createMavioError } from "../../core/errors.js";
import type { ProbeDetails } from "./probe-details.js";

export interface ThumbnailSource {
  readonly videoStreamIndex: number;
  readonly width: number;
  readonly height: number;
}

/** Accepts parsed probe details and selects video by source order. */
export function validateThumbnailSource(source: ProbeDetails): ThumbnailSource {
  const video = source.metadata.streams.find((stream) => stream.kind === "video");

  if (video === undefined) {
    throw createMavioError("INVALID_MEDIA", "Thumbnail creation requires a video stream.", {
      stage: "preparing",
      operation: "thumbnail",
      details: { reason: "MISSING_VIDEO" },
    });
  }

  function unsupported(reason: string): never {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The source is outside the initial native thumbnail profile.",
      {
        stage: "preparing",
        operation: "thumbnail",
        details: { reason, streamIndex: video!.index },
      },
    );
  }

  const details = source.streams.find((stream) => stream.index === video.index);

  if (details === undefined) {
    unsupported("MISSING_STREAM_DETAILS");
  }

  if (details.attachedPicture !== false) {
    unsupported("UNSUPPORTED_VIDEO_DISPOSITION");
  }

  if (details.pixelFormat !== "yuv420p") {
    unsupported("UNSUPPORTED_PIXEL_FORMAT");
  }

  if (
    details.colorTransfer !== "bt709" ||
    details.colorPrimaries !== "bt709" ||
    details.colorSpace !== "bt709" ||
    details.colorRange !== "tv"
  ) {
    unsupported("UNSUPPORTED_COLOR_PROFILE");
  }

  if (
    details.defaultOrientation !== true ||
    (video.rotationDegrees !== undefined && video.rotationDegrees !== 0)
  ) {
    unsupported("UNSUPPORTED_THUMBNAIL_ORIENTATION");
  }

  if (details.sampleAspectRatio !== "1:1") {
    unsupported("UNSUPPORTED_THUMBNAIL_SAMPLE_ASPECT_RATIO");
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
    throw createMavioError(
      "INVALID_MEDIA",
      "Thumbnail creation requires valid source dimensions.",
      {
        stage: "preparing",
        operation: "thumbnail",
        details: {
          reason: "INVALID_SOURCE_DIMENSIONS",
          streamIndex: video.index,
        },
      },
    );
  }

  return Object.freeze({
    videoStreamIndex: video.index,
    width,
    height,
  });
}
