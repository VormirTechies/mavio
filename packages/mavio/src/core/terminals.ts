import type { OperationName, OutputTarget, ProcessingPlan, Transformation } from "../contracts.js";
import { createMavioError } from "./errors.js";
import { captureTransformation } from "./transformations.js";

type TerminalPlan = Pick<ProcessingPlan, "terminal" | "output">;

function invalid(
  reason: string,
  message: string,
  operation?: OperationName,
  operationIndex?: number,
): never {
  throw createMavioError("INVALID_OPTIONS", message, {
    operation,
    details: {
      reason,
      ...(operationIndex === undefined ? {} : { operationIndex }),
    },
  });
}

function object(value: unknown, operation?: OperationName): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid("INVALID_SHAPE", "Options must be an object.", operation);
  }

  return value as Record<string, unknown>;
}

function captureOutput(value: unknown, operation?: OperationName): OutputTarget {
  const output = object(value, operation);

  switch (output.kind) {
    case "blob":
    case "bytes":
      return Object.freeze({ kind: output.kind });

    case "path": {
      const path = output.path;

      if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
        return invalid(
          "INVALID_OUTPUT_PATH",
          "Output path must be a nonempty string without null characters.",
          operation,
        );
      }

      return Object.freeze({ kind: "path", path });
    }

    default:
      return invalid("INVALID_OUTPUT_KIND", "Output kind must be blob, bytes, or path.", operation);
  }
}

export function captureExport(
  transformations: readonly Transformation[],
  value: unknown,
): TerminalPlan {
  const options = object(value);
  const output = captureOutput(options.output);
  const requestedFormat = options.format;

  if (
    requestedFormat !== undefined &&
    !["mp4", "webm", "mp3", "wav", "jpeg", "png"].includes(requestedFormat as string)
  ) {
    return invalid("INVALID_FORMAT", "Export format is not recognized.");
  }

  // Composition has already checked uniqueness and preset agreement.
  const convert = transformations.find((item) => item.type === "convert");
  const compress = transformations.find((item) => item.type === "compress");

  if (
    requestedFormat !== undefined &&
    convert !== undefined &&
    requestedFormat !== convert.options.format
  ) {
    return invalid("FORMAT_CONFLICT", "Export format must match the convert declaration.");
  }

  const format = requestedFormat ?? convert?.options.format;
  const preset = convert?.options.preset ?? compress?.options.preset;

  if (format === undefined) {
    return invalid("MISSING_FORMAT", "Select a format in convert or export.");
  }

  if (preset === undefined) {
    return invalid("MISSING_PRESET", "Select a preset in convert or compress.");
  }

  // Reuse preset validation, including the absence of a WebM preset.
  captureTransformation("convert", { format, preset });

  if (format !== "mp4" && format !== "mp3" && format !== "wav") {
    return invalid(
      "TERMINAL_FORMAT_MISMATCH",
      "Generic export supports MP4, MP3, or WAV. Use thumbnail for images.",
    );
  }

  return Object.freeze({
    terminal: Object.freeze({ type: "export", format, preset }),
    output,
  });
}

export function captureThumbnail(
  transformations: readonly Transformation[],
  value: unknown,
): TerminalPlan {
  const options = object(value, "thumbnail");
  const output = captureOutput(options.output, "thumbnail");
  const { at, format, preset } = options;

  if (typeof at !== "number" || !Number.isFinite(at) || at < 0) {
    return invalid("INVALID_TIME", "Thumbnail time must be finite and nonnegative.", "thumbnail");
  }

  if (format !== "jpeg" && format !== "png") {
    return invalid(
      "TERMINAL_FORMAT_MISMATCH",
      "Thumbnail format must be JPEG or PNG.",
      "thumbnail",
    );
  }

  // Translate shared encoding-validation errors to the terminal operation.
  let encoding: Transformation;
  try {
    encoding = captureTransformation("convert", { format, preset });
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      throw Object.assign(error, { operation: "thumbnail" });
    }
    throw error;
  }

  const incompatible = transformations.findIndex(
    (item) => item.type !== "trim" && item.type !== "resize",
  );

  if (incompatible !== -1) {
    return invalid(
      "INVALID_COMPOSITION",
      "Thumbnail allows only preceding trims and resizes.",
      transformations[incompatible].type,
      incompatible,
    );
  }

  // The shared helper was explicitly called for a convert declaration.
  if (encoding.type !== "convert") {
    throw new Error("Unexpected encoding declaration.");
  }

  return Object.freeze({
    terminal: Object.freeze({
      type: "thumbnail",
      at,
      format,
      preset: encoding.options.preset,
    }),
    output,
  });
}

export function validateMetadata(transformations: readonly Transformation[]): void {
  if (transformations.length !== 0) {
    invalid(
      "INVALID_COMPOSITION",
      "Metadata describes the source and accepts no transformations.",
      transformations[0].type,
      0,
    );
  }
}
