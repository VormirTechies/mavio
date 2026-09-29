import type { MediaFormat, PresetId, Transformation } from "../contracts.js";
import { createMavioError } from "./errors.js";

type TransformationType = Transformation["type"];

export const presetFormats: Readonly<Record<PresetId, MediaFormat>> = Object.freeze({
  "video-balanced-v1": "mp4",
  "video-small-v1": "mp4",
  "audio-balanced-v1": "mp3",
  "audio-pcm-v1": "wav",
  "jpeg-balanced-v1": "jpeg",
  "png-lossless-v1": "png",
});

function invalid(operation: TransformationType, reason: string, message: string): never {
  throw createMavioError("INVALID_OPTIONS", message, {
    operation,
    details: { reason },
  });
}

function readPreset(value: unknown, operation: TransformationType): PresetId {
  if (typeof value !== "string" || !Object.hasOwn(presetFormats, value)) {
    return invalid(operation, "UNKNOWN_PRESET", "Select a known preset.");
  }

  return value as PresetId;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function captureTransformation(type: TransformationType, value?: unknown): Transformation {
  const supplied = type === "extractAudio" && value === undefined ? {} : value;

  if (supplied === null || typeof supplied !== "object" || Array.isArray(supplied)) {
    return invalid(type, "INVALID_SHAPE", "Options must be an object.");
  }

  const options = supplied as Record<string, unknown>;

  switch (type) {
    case "trim": {
      const { start, end } = options;

      if (
        typeof start !== "number" ||
        typeof end !== "number" ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end <= start
      ) {
        return invalid(
          type,
          "INVALID_RANGE",
          "Trim requires finite seconds with start >= 0 and end > start.",
        );
      }

      return Object.freeze({
        type,
        options: Object.freeze({ start, end }),
      });
    }

    case "resize": {
      const { width, height } = options;

      if (!positiveInteger(width) || !positiveInteger(height)) {
        return invalid(
          type,
          "INVALID_DIMENSIONS",
          "Resize width and height must be positive integers.",
        );
      }

      return Object.freeze({
        type,
        options: Object.freeze({ width, height }),
      });
    }

    case "convert": {
      const preset = readPreset(options.preset, type);
      const format = presetFormats[preset];

      if (options.format !== format) {
        return invalid(
          type,
          "PRESET_FORMAT_MISMATCH",
          "Convert format must match the selected preset.",
        );
      }

      return Object.freeze({
        type,
        options: Object.freeze({ format, preset }),
      });
    }

    case "compress": {
      const preset = readPreset(options.preset, type);

      return Object.freeze({
        type,
        options: Object.freeze({ preset }),
      });
    }

    case "extractAudio": {
      const { streamIndex } = options;

      if (
        streamIndex !== undefined &&
        (typeof streamIndex !== "number" || !Number.isInteger(streamIndex) || streamIndex < 0)
      ) {
        return invalid(
          type,
          "INVALID_STREAM_INDEX",
          "Audio stream index must be a nonnegative integer.",
        );
      }

      return Object.freeze({
        type,
        options: Object.freeze(streamIndex === undefined ? {} : { streamIndex }),
      });
    }
  }
}
