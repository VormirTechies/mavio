import type { PresetId, Transformation } from "../contracts.js";
import { createMavioError } from "./errors.js";
import { captureTransformation, presetFormats } from "./transformations.js";

export const EMPTY_TRANSFORMATIONS: readonly Transformation[] = Object.freeze([]);

function invalid(
  operation: Transformation["type"],
  operationIndex: number,
  reason: string,
  message: string,
): never {
  throw createMavioError("INVALID_OPTIONS", message, {
    operation,
    details: { reason, operationIndex },
  });
}

function validateComposition(transformations: readonly Transformation[]): void {
  let converted = false;
  let compressed = false;
  let extracted = false;
  let selectedPreset: PresetId | undefined;

  for (const [index, transformation] of transformations.entries()) {
    const { type } = transformation;

    if (
      (type === "convert" && converted) ||
      (type === "compress" && compressed) ||
      (type === "extractAudio" && extracted)
    ) {
      invalid(type, index, "DUPLICATE_OPERATION", `${type} may appear only once in a pipeline.`);
    }

    if (type === "resize" && extracted) {
      invalid(type, index, "STREAM_PLAN_MISMATCH", "Resize cannot follow audio extraction.");
    }

    if (type === "convert" || type === "compress") {
      const preset = transformation.options.preset;

      if (selectedPreset !== undefined && selectedPreset !== preset) {
        invalid(
          type,
          index,
          "PRESET_CONFLICT",
          "Convert and compress must select the same preset.",
        );
      }

      if (extracted && presetFormats[preset] === "mp4") {
        invalid(
          type,
          index,
          "STREAM_PLAN_MISMATCH",
          "An audio extraction pipeline cannot use a video preset.",
        );
      }

      selectedPreset = preset;
      if (type === "convert") converted = true;
      if (type === "compress") compressed = true;
    }

    if (type === "extractAudio") {
      if (selectedPreset !== undefined && presetFormats[selectedPreset] === "mp4") {
        invalid(
          type,
          index,
          "STREAM_PLAN_MISMATCH",
          "An audio extraction pipeline cannot use a video preset.",
        );
      }

      extracted = true;
    }
  }
}

/**
 * Accepts chains created by this module. Each append returns a new frozen
 * array; existing transformations are already captured and frozen.
 */
export function appendTransformation(
  current: readonly Transformation[],
  type: Transformation["type"],
  options?: unknown,
): readonly Transformation[] {
  const transformation = captureTransformation(type, options);
  const next = [...current, transformation];

  validateComposition(next);

  return Object.freeze(next);
}
