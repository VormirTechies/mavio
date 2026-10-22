import type { MediaMetadata } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import { parseFFprobeMetadata } from "../shared/probe-metadata.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse a fresh ffprobe JSON output from the pinned browser core.
 *
 * The caller must ensure the output belongs to this probe attempt.
 * Parsing alone cannot establish output freshness.
 */
export function parseBrowserProbeMetadata(
  text: string,
  exitCode: number,
  jobId?: string,
): MediaMetadata {
  function invalid(field: string): never {
    throw createMavioError(
      "EXECUTION_FAILED",
      "Browser FFprobe returned an invalid metadata response.",
      {
        stage: "preparing",
        jobId,
        details: {
          reason: "INVALID_PROBE_RESPONSE",
          tool: "ffprobe",
          field,
        },
      },
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    // Parser errors may contain media-derived text.
    invalid("$");
  }

  if (!isRecord(parsed)) invalid("$");

  if (parsed.error !== undefined) {
    const error = parsed.error;

    if (
      !isRecord(error) ||
      typeof error.code !== "number" ||
      !Number.isSafeInteger(error.code) ||
      error.code === 0 ||
      typeof error.string !== "string"
    ) {
      invalid("$.error");
    }

    throw createMavioError("INVALID_MEDIA", "Browser FFprobe could not read the supplied media.", {
      stage: "preparing",
      jobId,
      details: { reason: "PROBE_REJECTED_MEDIA" },
    });
  }

  // The pinned core can return -1 with valid structured probe output.
  // Other exit codes are not treated as success.
  if (exitCode !== 0 && exitCode !== -1) {
    throw createMavioError("EXECUTION_FAILED", "Browser FFprobe did not complete successfully.", {
      stage: "preparing",
      jobId,
      details: { reason: "PROBE_EXIT_FAILURE" },
    });
  }

  if (!isRecord(parsed.format)) invalid("$.format");

  if (!Array.isArray(parsed.streams) || parsed.streams.length === 0) {
    invalid("$.streams");
  }

  return parseFFprobeMetadata(text, jobId);
}
