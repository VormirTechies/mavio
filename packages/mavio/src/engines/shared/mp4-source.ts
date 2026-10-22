import { createMavioError } from "../../core/errors.js";
import { selectNativeMp4Streams, type NativeMp4Streams } from "./mp4-streams.js";
import type { ProbeDetails as NativeProbeDetails } from "./probe-details.js";
import type { Mp4Preset as NativeMp4Preset } from "./mp4-encoding.js";

export function validateBalancedMp4Source(
  source: NativeProbeDetails,
  preset: NativeMp4Preset = "video-balanced-v1",
): NativeMp4Streams {
  const selected = selectNativeMp4Streams(source.metadata);

  function unsupported(reason: string, streamIndex: number): never {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The source is outside the currently supported MP4 encoding profile.",
      {
        stage: "preparing",
        details: {
          reason,
          streamIndex,
          preset,
        },
      },
    );
  }

  const video = source.streams.find((stream) => stream.index === selected.videoStreamIndex);

  if (video === undefined) {
    unsupported("MISSING_STREAM_DETAILS", selected.videoStreamIndex);
  }

  if (video.attachedPicture !== false) {
    unsupported("UNSUPPORTED_VIDEO_DISPOSITION", video.index);
  }

  if (video.pixelFormat !== "yuv420p") {
    unsupported("UNSUPPORTED_PIXEL_FORMAT", video.index);
  }

  if (
    video.colorTransfer !== "bt709" ||
    video.colorPrimaries !== "bt709" ||
    video.colorSpace !== "bt709" ||
    video.colorRange !== "tv"
  ) {
    unsupported("UNSUPPORTED_COLOR_PROFILE", video.index);
  }

  if (selected.audioStreamIndex !== undefined) {
    const audioIndex = selected.audioStreamIndex;

    const audio = source.metadata.streams.find(
      (stream) => stream.index === audioIndex && stream.kind === "audio",
    );

    const details = source.streams.find((stream) => stream.index === audioIndex);

    if (audio === undefined || details === undefined) {
      unsupported("MISSING_STREAM_DETAILS", audioIndex);
    }

    if (audio.sampleRate !== 44_100 && audio.sampleRate !== 48_000) {
      unsupported("UNSUPPORTED_AUDIO_SAMPLE_RATE", audioIndex);
    }

    const supportedLayout =
      (audio.channels === 1 && details.channelLayout === "mono") ||
      (audio.channels === 2 && details.channelLayout === "stereo");

    if (!supportedLayout) {
      unsupported("UNSUPPORTED_AUDIO_LAYOUT", audioIndex);
    }
  }

  return selected;
}
