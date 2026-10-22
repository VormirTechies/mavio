import type { MediaMetadata as MavioMediaMetadata } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";

export interface NativeMp4Streams {
  readonly videoStreamIndex: number;
  readonly audioStreamIndex?: number;
}

/**
 * Accepts metadata already validated by the core.
 * Selection alone does not establish encoding compatibility.
 */
export function selectNativeMp4Streams(source: MavioMediaMetadata): NativeMp4Streams {
  const video = source.streams.find((stream) => stream.kind === "video");
  const audio = source.streams.find((stream) => stream.kind === "audio");

  if (video === undefined) {
    throw createMavioError("INVALID_MEDIA", "The MP4 video preset requires a video stream.", {
      stage: "preparing",
      details: { reason: "MISSING_VIDEO" },
    });
  }

  return Object.freeze({
    videoStreamIndex: video.index,
    ...(audio === undefined ? {} : { audioStreamIndex: audio.index }),
  });
}
