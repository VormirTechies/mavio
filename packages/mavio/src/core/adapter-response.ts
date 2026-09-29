import type {
  EngineAdapter,
  EngineCapabilities,
  MediaMetadata,
  OutputTarget,
  SupportResult,
} from "../contracts.js";
import { createMavioError } from "./errors.js";
import { presetFormats } from "./transformations.js";

const operations = [
  "convert",
  "compress",
  "trim",
  "resize",
  "extractAudio",
  "thumbnail",
  "metadata",
];

const kinds = ["blob", "bytes", "path"];
const formats = ["mp4", "webm", "mp3", "wav", "jpeg", "png"];

class InvalidField extends Error {
  constructor(readonly field: string) {
    super(`Invalid adapter response field: ${field}`);
  }
}

function invalid(field: string): never {
  throw new InvalidField(field);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(field);
  }

  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) return invalid(field);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") return invalid(field);
  return value;
}

function choice(value: unknown, field: string, allowed: readonly string[]): void {
  if (!allowed.includes(text(value, field))) invalid(field);
}

function strings(value: unknown, field: string, allowed?: readonly string[]): void {
  for (const [index, item] of array(value, field).entries()) {
    const location = `${field}[${index}]`;

    if (allowed === undefined) {
      text(item, location);
    } else {
      choice(item, location, allowed);
    }
  }
}

function numeric(value: unknown, field: string, minimum = 0, integer = false): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    (integer && !Number.isSafeInteger(value))
  ) {
    invalid(field);
  }
}

function optionalNumber(
  object: Record<string, unknown>,
  key: string,
  field: string,
  minimum = 0,
  integer = false,
): void {
  if (object[key] !== undefined) {
    numeric(object[key], `${field}.${key}`, minimum, integer);
  }
}

function optionalText(object: Record<string, unknown>, key: string, field: string): void {
  if (object[key] !== undefined) {
    text(object[key], `${field}.${key}`);
  }
}

function capture<T>(
  value: unknown,
  response: "capabilities" | "metadata" | "support" | "execution",
  validate: (snapshot: unknown) => void,
): T {
  try {
    const snapshot: unknown = structuredClone(value);
    validate(snapshot);
    return snapshot as T;
  } catch (cause) {
    throw createMavioError(
      response === "capabilities" ? "ENGINE_INIT_FAILED" : "EXECUTION_FAILED",
      `Engine returned invalid ${response}.`,
      {
        stage: "preparing",
        details: {
          reason: "ENGINE_CONTRACT_VIOLATION",
          response,
          field: cause instanceof InvalidField ? cause.field : "$",
        },
        cause,
      },
    );
  }
}

export function captureCapabilities(
  value: unknown,
  engine: Pick<EngineAdapter, "id" | "runtime">,
): EngineCapabilities {
  return capture<EngineCapabilities>(value, "capabilities", (snapshot) => {
    const data = record(snapshot, "$");

    if (data.engineId !== engine.id) invalid("$.engineId");
    if (data.runtime !== engine.runtime) invalid("$.runtime");
    text(data.engineVersion, "$.engineVersion");

    strings(data.operations, "$.operations", operations);
    strings(data.inputKinds, "$.inputKinds", kinds);
    strings(data.outputKinds, "$.outputKinds", kinds);
    strings(data.readableContainers, "$.readableContainers");
    strings(data.decoders, "$.decoders");

    for (const [index, item] of array(data.encodings, "$.encodings").entries()) {
      const field = `$.encodings[${index}]`;
      const encoding = record(item, field);

      choice(encoding.container, `${field}.container`, formats);
      choice(encoding.preset, `${field}.preset`, Object.keys(presetFormats));
      optionalText(encoding, "videoCodec", field);
      optionalText(encoding, "audioCodec", field);
    }

    const limits = record(data.limits, "$.limits");
    optionalNumber(limits, "maxInputBytes", "$.limits", 0, true);
    optionalNumber(limits, "maxWidth", "$.limits", 1, true);
    optionalNumber(limits, "maxHeight", "$.limits", 1, true);
  });
}

export function captureMetadata(value: unknown): MediaMetadata {
  return capture<MediaMetadata>(value, "metadata", (snapshot) => {
    const data = record(snapshot, "$");

    optionalNumber(data, "durationSeconds", "$");
    optionalNumber(data, "sizeBytes", "$", 0, true);
    optionalNumber(data, "bitrateBitsPerSecond", "$");
    optionalText(data, "container", "$");

    const indexes = new Set<number>();

    for (const [position, item] of array(data.streams, "$.streams").entries()) {
      const field = `$.streams[${position}]`;
      const stream = record(item, field);

      numeric(stream.index, `${field}.index`, 0, true);
      const index = stream.index as number;

      if (indexes.has(index)) invalid(`${field}.index`);
      indexes.add(index);

      choice(stream.kind, `${field}.kind`, ["video", "audio", "subtitle", "other"]);

      optionalText(stream, "codec", field);
      optionalNumber(stream, "width", field, 1, true);
      optionalNumber(stream, "height", field, 1, true);
      optionalNumber(stream, "sampleRate", field, 1, true);
      optionalNumber(stream, "channels", field, 1, true);
      optionalNumber(stream, "rotationDegrees", field, -Infinity);

      if (stream.frameRate !== undefined) {
        const frameRate = record(stream.frameRate, `${field}.frameRate`);

        numeric(frameRate.numerator, `${field}.frameRate.numerator`, 0, true);
        numeric(frameRate.denominator, `${field}.frameRate.denominator`, 1, true);
      }
    }
  });
}

export function captureSupportResult(value: unknown): SupportResult {
  return capture<SupportResult>(value, "support", (snapshot) => {
    const data = record(snapshot, "$");

    choice(data.status, "$.status", ["supported", "unsupported", "unknown"]);

    if (data.status === "supported") return;

    for (const [index, item] of array(data.issues, "$.issues").entries()) {
      const field = `$.issues[${index}]`;
      const issue = record(item, field);

      text(issue.code, `${field}.code`);
      text(issue.message, `${field}.message`);

      if (issue.operation !== undefined) {
        choice(issue.operation, `${field}.operation`, operations);
      }
    }
  });
}

type ExecutionResult = Awaited<ReturnType<EngineAdapter["execute"]>>;

export function captureExecutionResult(value: unknown, expected: OutputTarget): ExecutionResult {
  const result = capture<ExecutionResult>(value, "execution", (snapshot) => {
    const data = record(snapshot, "$");
    const output = record(data.output, "$.output");

    choice(output.kind, "$.output.kind", kinds);

    if (output.kind !== expected.kind) invalid("$.output.kind");

    switch (output.kind) {
      case "bytes":
        if (!(output.bytes instanceof Uint8Array) || output.bytes.byteLength === 0) {
          invalid("$.output.bytes");
        }
        break;

      case "blob":
        if (!(output.blob instanceof Blob) || output.blob.size === 0) {
          invalid("$.output.blob");
        }
        break;

      case "path":
        if (expected.kind !== "path" || output.path !== expected.path) {
          invalid("$.output.path");
        }
        break;
    }

    try {
      captureMetadata(data.metadata);
    } catch {
      invalid("$.metadata");
    }

    if (data.warnings !== undefined) {
      for (const [index, item] of array(data.warnings, "$.warnings").entries()) {
        const field = `$.warnings[${index}]`;
        const warning = record(item, field);

        choice(warning.code, `${field}.code`, ["CLEANUP_FAILED"]);
        text(warning.message, `${field}.message`);
      }
    }
  });

  // structuredClone copies ordinary buffers, but shared buffers remain shared.
  if (
    result.output.kind === "bytes" &&
    typeof SharedArrayBuffer !== "undefined" &&
    result.output.bytes.buffer instanceof SharedArrayBuffer
  ) {
    result.output = {
      kind: "bytes",
      bytes: new Uint8Array(result.output.bytes),
    };
  }

  return result;
}
