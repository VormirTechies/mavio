import { createMavioError } from "../../core/errors.js";
import type { ProbeDetails } from "./probe-details.js";
import type { ThumbnailPreset } from "./thumbnail-encoding.js";

export interface ThumbnailOutputExpectation {
  readonly preset: ThumbnailPreset;
  readonly width: number;
  readonly height: number;
}

/** Accepts parsed probe details and a validated output expectation. */
export function validateThumbnailOutput(
  output: ProbeDetails,
  expected: ThumbnailOutputExpectation,
  jobId?: string,
): void {
  function invalid(reason: string): never {
    throw createMavioError(
      "EXECUTION_FAILED",
      "The encoded thumbnail does not match the expected output.",
      {
        stage: "finalizing",
        operation: "thumbnail",
        jobId,
        details: { reason, preset: expected.preset },
      },
    );
  }

  const { metadata } = output;

  if (
    metadata.sizeBytes === undefined ||
    !Number.isSafeInteger(metadata.sizeBytes) ||
    metadata.sizeBytes <= 0
  ) {
    invalid("INVALID_OUTPUT_SIZE");
  }

  if (metadata.streams.length !== 1 || metadata.streams[0]?.kind !== "video") {
    invalid("OUTPUT_STREAMS_MISMATCH");
  }

  const image = metadata.streams[0]!;
  const jpeg = expected.preset === "jpeg-balanced-v1";

  if (image.codec !== (jpeg ? "mjpeg" : "png")) {
    invalid("OUTPUT_IMAGE_CODEC_MISMATCH");
  }

  if (image.width !== expected.width || image.height !== expected.height) {
    invalid("OUTPUT_DIMENSIONS_MISMATCH");
  }

  const details = output.streams[0];

  if (
    output.streams.length !== 1 ||
    details === undefined ||
    details.index !== image.index ||
    details.pixelFormat !== (jpeg ? "yuvj420p" : "rgb24")
  ) {
    invalid("OUTPUT_IMAGE_PROFILE_MISMATCH");
  }

  if (
    details.defaultOrientation !== true ||
    (image.rotationDegrees !== undefined && image.rotationDegrees !== 0) ||
    (details.sampleAspectRatio !== undefined && details.sampleAspectRatio !== "1:1")
  ) {
    invalid("OUTPUT_IMAGE_GEOMETRY_MISMATCH");
  }
}
