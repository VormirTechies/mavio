import type {
  EngineCapabilities,
  ErrorCode,
  MediaMetadata,
  OperationName,
  ProcessingPlan,
} from "../contracts.js";
import { createMavioError } from "./errors.js";

function fail(
  code: ErrorCode,
  reason: string,
  message: string,
  operation: OperationName,
  operationIndex?: number,
): never {
  throw createMavioError(code, message, {
    stage: "preparing",
    operation,
    details: {
      reason,
      ...(operationIndex === undefined ? {} : { operationIndex }),
    },
  });
}

function terminalOperation(plan: ProcessingPlan): OperationName {
  if (plan.terminal.type === "thumbnail") return "thumbnail";

  return plan.transformations.some((item) => item.type === "convert") ? "convert" : "compress";
}

export function validatePlanCapabilities(
  plan: ProcessingPlan,
  capabilities: EngineCapabilities,
): void {
  const operation = terminalOperation(plan);

  if (
    !capabilities.inputKinds.includes(plan.input.kind) ||
    !capabilities.outputKinds.includes(plan.output.kind)
  ) {
    fail(
      "UNSUPPORTED_CAPABILITY",
      "UNSUPPORTED_IO_KIND",
      "Engine does not support the requested input or output kind.",
      operation,
    );
  }

  const required: OperationName[] = ["metadata", ...plan.transformations.map((item) => item.type)];

  if (plan.terminal.type === "thumbnail") required.push("thumbnail");

  for (const requiredOperation of required) {
    if (!capabilities.operations.includes(requiredOperation)) {
      fail(
        "UNSUPPORTED_CAPABILITY",
        "MISSING_OPERATION",
        `Engine does not support ${requiredOperation}.`,
        requiredOperation,
      );
    }
  }

  if (
    !capabilities.encodings.some(
      (encoding) =>
        encoding.container === plan.terminal.format && encoding.preset === plan.terminal.preset,
    )
  ) {
    fail(
      "UNSUPPORTED_CAPABILITY",
      "MISSING_ENCODING",
      "Engine does not advertise the requested format and preset.",
      operation,
    );
  }
}

export function validateSource(plan: ProcessingPlan, source: MediaMetadata): void {
  let duration = source.durationSeconds;
  let hasVideo = source.streams.some((stream) => stream.kind === "video");
  let audio = source.streams.find((stream) => stream.kind === "audio");

  function knownDuration(operation: OperationName, operationIndex: number): number {
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      return fail(
        "INVALID_MEDIA",
        "UNKNOWN_DURATION",
        "This operation requires a known media duration.",
        operation,
        operationIndex,
      );
    }

    return duration;
  }

  function requireVideo(operation: OperationName, operationIndex: number): void {
    if (!hasVideo) {
      fail(
        "INVALID_MEDIA",
        "MISSING_VIDEO",
        "This operation requires a video stream.",
        operation,
        operationIndex,
      );
    }
  }

  function requireAudio(operation: OperationName, operationIndex: number): void {
    if (audio === undefined) {
      fail(
        "INVALID_MEDIA",
        "MISSING_AUDIO",
        "This operation requires an audio stream.",
        operation,
        operationIndex,
      );
    }
  }

  for (const [index, transformation] of plan.transformations.entries()) {
    switch (transformation.type) {
      case "trim": {
        const { start, end } = transformation.options;

        if (end > knownDuration("trim", index)) {
          fail(
            "INVALID_OPTIONS",
            "OUT_OF_RANGE",
            "Trim exceeds the current logical duration.",
            "trim",
            index,
          );
        }

        duration = end - start;
        break;
      }

      case "resize":
        requireVideo("resize", index);
        break;

      case "extractAudio": {
        const { streamIndex } = transformation.options;

        if (streamIndex !== undefined) {
          audio = source.streams.find(
            (stream) => stream.index === streamIndex && stream.kind === "audio",
          );

          if (audio === undefined) {
            fail(
              "INVALID_OPTIONS",
              "INVALID_STREAM_INDEX",
              "The selected source index is not an audio stream.",
              "extractAudio",
              index,
            );
          }
        }

        requireAudio("extractAudio", index);
        hasVideo = false;
        break;
      }

      // Encoding declarations do not change the intermediate timeline.
      case "convert":
      case "compress":
        break;
    }
  }

  const index = plan.transformations.length;
  const operation = terminalOperation(plan);

  if (plan.terminal.type === "thumbnail") {
    requireVideo(operation, index);

    if (plan.terminal.at >= knownDuration(operation, index)) {
      fail(
        "INVALID_OPTIONS",
        "OUT_OF_RANGE",
        "Thumbnail time must be earlier than the logical duration.",
        operation,
        index,
      );
    }
  } else if (plan.terminal.format === "mp4") {
    requireVideo(operation, index);
  } else if (plan.terminal.format === "mp3" || plan.terminal.format === "wav") {
    requireAudio(operation, index);
  }
}
