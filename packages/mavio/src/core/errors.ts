import type { ErrorCode, JobStage, MavioError, OperationName } from "../contracts.js";

interface ErrorContext {
  stage?: JobStage;
  jobId?: string;
  operation?: OperationName;
  engineId?: string;
  details?: Readonly<Record<string, string | number | boolean>>;
  cleanupIssues?: readonly string[];
  cause?: unknown;
}

export function createMavioError(
  code: ErrorCode,
  message: string,
  context: ErrorContext = {},
): MavioError {
  const error = new Error(message, { cause: context.cause });
  error.name = "MavioError";

  return Object.assign(error, {
    code,
    stage: context.stage ?? "queued",
    jobId: context.jobId,
    operation: context.operation,
    engineId: context.engineId,
    details: context.details === undefined ? undefined : Object.freeze({ ...context.details }),
    cleanupIssues:
      context.cleanupIssues === undefined ? undefined : Object.freeze([...context.cleanupIssues]),
  });
}

const knownCodes = new Set<unknown>([
  "INVALID_INPUT",
  "INVALID_OPTIONS",
  "INVALID_MEDIA",
  "UNSUPPORTED_RUNTIME",
  "UNSUPPORTED_CAPABILITY",
  "ENGINE_UNAVAILABLE",
  "ENGINE_INIT_FAILED",
  "EXECUTION_FAILED",
  "OUTPUT_EXISTS",
  "IO_ERROR",
  "RESOURCE_LIMIT",
  "QUEUE_FULL",
  "CANCELLED",
  "DISPOSED",
  "CLEANUP_FAILED",
]);

export function getErrorCode(value: unknown): ErrorCode | undefined {
  if (value instanceof Error && "code" in value && knownCodes.has(value.code)) {
    return value.code as ErrorCode;
  }

  return undefined;
}
