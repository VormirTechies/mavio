import { createMavioError } from "../../core/errors.js";

export interface NativeTrimSelection {
  readonly videoFrames: number;
  readonly audioSamples?: number;
}

/** Counts must come from completed, successful selection analysis. */
export function validateNativeTrimSelection(
  selection: NativeTrimSelection,
  hasAudio: boolean,
  jobId?: string,
): void {
  function invalidEvidence(field: string): never {
    throw createMavioError(
      "EXECUTION_FAILED",
      "Native trim analysis returned invalid selection counts.",
      {
        stage: "preparing",
        operation: "trim",
        jobId,
        details: { reason: "INVALID_TRIM_SELECTION", field },
      },
    );
  }

  function validateCount(value: unknown, field: string): void {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      invalidEvidence(field);
    }
  }

  if (typeof hasAudio !== "boolean") {
    invalidEvidence("hasAudio");
  }

  validateCount(selection.videoFrames, "videoFrames");

  if (hasAudio || selection.audioSamples !== undefined) {
    validateCount(selection.audioSamples, "audioSamples");
  }

  // Validate all evidence before classifying an interval as empty.
  const emptyStream =
    selection.videoFrames === 0
      ? "video"
      : hasAudio && selection.audioSamples === 0
        ? "audio"
        : undefined;

  if (emptyStream !== undefined) {
    throw createMavioError(
      "INVALID_OPTIONS",
      `The trim interval contains no selected ${emptyStream} content.`,
      {
        stage: "preparing",
        operation: "trim",
        jobId,
        details: {
          reason: "RANGE_TOO_SHORT",
          streamKind: emptyStream,
        },
      },
    );
  }
}
