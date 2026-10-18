import { createMavioError } from "../../core/errors.js";
import type { NativeProbeDetails } from "./probe-details.js";
import type { NativeMp4Preset } from "./mp4-encoding.js";

export interface NativeMp4OutputExpectation {
  readonly width: number;
  readonly height: number;
  readonly audio?: {
    readonly sampleRate: number;
    readonly channels: number;
    readonly channelLayout: string;
  };
  readonly requireNormalizedGeometry?: boolean;
  readonly preset?: NativeMp4Preset;
}

/**
 * Accepts parsed probe details and the execution plan's expected output.
 * Expected dimensions must account for any supported transformations.
 */
export function validateNativeMp4Output(
  output: NativeProbeDetails,
  expected: NativeMp4OutputExpectation,
  jobId?: string,
): void {
  function invalid(reason: string): never {
    throw createMavioError(
      "EXECUTION_FAILED",
      "The encoded MP4 does not match the expected output.",
      {
        stage: "finalizing",
        jobId,
        details: {
          reason,
          preset: expected.preset ?? "video-balanced-v1",
        },
      },
    );
  }

  const { metadata } = output;

  // FFprobe reports a shared MOV/MP4 demuxer name.
  // This is a format-family check, not proof of a specific MP4 brand.
  if (!metadata.container?.split(",").includes("mp4")) {
    invalid("OUTPUT_CONTAINER_MISMATCH");
  }

  if (
    metadata.durationSeconds === undefined ||
    !Number.isFinite(metadata.durationSeconds) ||
    metadata.durationSeconds <= 0
  ) {
    invalid("INVALID_OUTPUT_DURATION");
  }

  if (
    metadata.sizeBytes === undefined ||
    !Number.isSafeInteger(metadata.sizeBytes) ||
    metadata.sizeBytes <= 0
  ) {
    invalid("INVALID_OUTPUT_SIZE");
  }

  const videos = metadata.streams.filter((stream) => stream.kind === "video");
  const audios = metadata.streams.filter((stream) => stream.kind === "audio");
  const audioCount = expected.audio === undefined ? 0 : 1;

  if (
    videos.length !== 1 ||
    audios.length !== audioCount ||
    metadata.streams.length !== 1 + audioCount
  ) {
    invalid("OUTPUT_STREAMS_MISMATCH");
  }

  const video = videos[0]!;

  if (video.codec !== "h264") {
    invalid("OUTPUT_VIDEO_CODEC_MISMATCH");
  }

  if (video.width !== expected.width || video.height !== expected.height) {
    invalid("OUTPUT_DIMENSIONS_MISMATCH");
  }

  const videoDetails = output.streams.find((stream) => stream.index === video.index);

  if (
    videoDetails === undefined ||
    videoDetails.attachedPicture !== false ||
    videoDetails.pixelFormat !== "yuv420p" ||
    videoDetails.colorTransfer !== "bt709" ||
    videoDetails.colorPrimaries !== "bt709" ||
    videoDetails.colorSpace !== "bt709" ||
    videoDetails.colorRange !== "tv"
  ) {
    invalid("OUTPUT_VIDEO_PROFILE_MISMATCH");
  }

  if (expected.requireNormalizedGeometry) {
    if (videoDetails.sampleAspectRatio !== "1:1") {
      invalid("OUTPUT_SAMPLE_ASPECT_RATIO_MISMATCH");
    }

    if (
      videoDetails.defaultOrientation !== true ||
      (video.rotationDegrees !== undefined && video.rotationDegrees !== 0)
    ) {
      invalid("OUTPUT_ORIENTATION_MISMATCH");
    }
  }

  if (expected.audio !== undefined) {
    const audio = audios[0]!;
    const audioDetails = output.streams.find((stream) => stream.index === audio.index);

    if (audio.codec !== "aac") {
      invalid("OUTPUT_AUDIO_CODEC_MISMATCH");
    }

    if (
      audio.sampleRate !== expected.audio.sampleRate ||
      audio.channels !== expected.audio.channels ||
      audioDetails?.channelLayout !== expected.audio.channelLayout
    ) {
      invalid("OUTPUT_AUDIO_PROFILE_MISMATCH");
    }
  }
}
