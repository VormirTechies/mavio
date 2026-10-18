import type { MediaMetadata, MediaStream } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optionalNumber(value: unknown, minimum = 0, integer = false): number | undefined {
  let number: number;

  if (typeof value === "number") {
    number = value;
  } else if (
    typeof value === "string" &&
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
  ) {
    number = Number(value);
  } else {
    return undefined;
  }

  if (!Number.isFinite(number) || number < minimum || (integer && !Number.isSafeInteger(number))) {
    return undefined;
  }

  return number;
}

function averageFrameRate(value: unknown): MediaStream["frameRate"] {
  if (typeof value !== "string") return undefined;

  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (match === null) return undefined;

  const numerator = optionalNumber(match[1], 1, true);
  const denominator = optionalNumber(match[2], 1, true);

  if (numerator === undefined || denominator === undefined) {
    return undefined;
  }

  return { numerator, denominator };
}

export function parseNativeProbeMetadata(text: string, jobId?: string): MediaMetadata {
  function invalid(field: string): never {
    throw createMavioError("EXECUTION_FAILED", "FFprobe returned an invalid metadata response.", {
      stage: "preparing",
      jobId,
      details: {
        reason: "INVALID_PROBE_RESPONSE",
        tool: "ffprobe",
        field,
      },
    });
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON parser messages can include source text. Do not expose them.
    invalid("$");
  }

  if (!isRecord(parsed)) invalid("$");

  if (parsed.error !== undefined) {
    invalid("$.error");
  }

  if (!Array.isArray(parsed.streams)) {
    invalid("$.streams");
  }

  const format = parsed.format === undefined ? {} : parsed.format;

  if (!isRecord(format)) {
    invalid("$.format");
  }

  const indexes = new Set<number>();

  const streams: MediaStream[] = parsed.streams.map((value, position) => {
    const field = `$.streams[${position}]`;

    if (!isRecord(value)) invalid(field);

    // FFprobe emits stream indexes as JSON numbers.
    if (
      typeof value.index !== "number" ||
      !Number.isSafeInteger(value.index) ||
      value.index < 0 ||
      indexes.has(value.index)
    ) {
      invalid(`${field}.index`);
    }

    indexes.add(value.index);

    const kind: MediaStream["kind"] =
      value.codec_type === "video" ||
      value.codec_type === "audio" ||
      value.codec_type === "subtitle"
        ? value.codec_type
        : "other";

    const stream: MediaStream = {
      index: value.index,
      kind,
      codec: optionalText(value.codec_name),
    };

    if (kind === "video") {
      stream.width = optionalNumber(value.width, 1, true);
      stream.height = optionalNumber(value.height, 1, true);
      stream.frameRate = averageFrameRate(value.avg_frame_rate);

      const rotation = rotationDegrees(value);

      if (rotation !== undefined) {
        stream.rotationDegrees = rotation;
      }
    }

    if (kind === "audio") {
      stream.sampleRate = optionalNumber(value.sample_rate, 1, true);
      stream.channels = optionalNumber(value.channels, 1, true);
    }

    return stream;
  });

  return {
    durationSeconds: optionalNumber(format.duration),
    sizeBytes: optionalNumber(format.size, 0, true),
    container: optionalText(format.format_name),
    bitrateBitsPerSecond: optionalNumber(format.bit_rate),
    streams,
  };
}

function normalizeRotation(value: number): number {
  const remainder = value % 360;

  // Avoid exposing negative zero.
  if (remainder === 0) return 0;

  return remainder < 0 ? remainder + 360 : remainder;
}

function rotationDegrees(stream: Record<string, unknown>): number | undefined {
  const sideData = stream.side_data_list;

  if (sideData !== undefined) {
    if (!Array.isArray(sideData) || !sideData.every(isRecord)) {
      return undefined;
    }

    const matrices = sideData.filter((entry) => entry.side_data_type === "Display Matrix");

    if (matrices.length > 0) {
      // Multiple matrices are ambiguous. A malformed matrix must not
      // silently fall back to a potentially stale rotation tag.
      if (matrices.length !== 1) return undefined;

      const angle = optionalNumber(matrices[0].rotation, -Infinity);

      return angle === undefined ? undefined : normalizeRotation(-angle);
    }
  }

  if (!isRecord(stream.tags)) return undefined;

  // Legacy rotate tags use the clockwise convention.
  const angle = optionalNumber(stream.tags.rotate, -Infinity);

  return angle === undefined ? undefined : normalizeRotation(angle);
}
