import { posix, win32 } from "node:path";
import type { EngineContext, ErrorCode } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import type { NativeAudioTrimFilters } from "./audio-trim-filters.js";
import type { NativeConfiguration } from "./config.js";
import type { NativeInventory } from "./inventory.js";
import type { PreparedNativeTools } from "./prepare.js";
import { NativeProcessError, runNativeProcess } from "./process.js";
import { parseNativeTrimCount } from "./trim-counts.js";

interface AnalysisOptions {
  configuration: NativeConfiguration;
  tools: PreparedNativeTools;
  inventory: NativeInventory;
  inputPath: string;
  streamIndex: number;
  channels: number;
  filters: NativeAudioTrimFilters;
  context: Pick<EngineContext, "jobId" | "signal">;
}

/** Counts decoded sample frames per channel, not interleaved scalar values. */
export async function analyzeNativeAudioTrim(
  options: AnalysisOptions,
  dependencies: { run?: typeof runNativeProcess } = {},
): Promise<{ readonly audioSamples: number }> {
  const { configuration, tools, inventory, inputPath, streamIndex, channels, filters, context } =
    options;

  const run = dependencies.run ?? runNativeProcess;

  function fail(code: ErrorCode, reason: string, message: string, cause?: unknown): never {
    throw createMavioError(code, message, {
      stage: "preparing",
      operation: "trim",
      jobId: context.jobId,
      details: { reason },
      cause,
    });
  }

  function checkAbort(): void {
    if (context.signal.aborted) {
      fail(
        "CANCELLED",
        "CANCELLED",
        "Native audio trim analysis was cancelled.",
        context.signal.reason,
      );
    }
  }

  checkAbort();

  const paths = configuration.platform === "win32" ? win32 : posix;

  if (
    !paths.isAbsolute(inputPath) ||
    inputPath.includes("\0") ||
    (configuration.platform === "win32" && paths.parse(inputPath).root.length <= 1) ||
    !Number.isSafeInteger(streamIndex) ||
    streamIndex < 0 ||
    (channels !== 1 && channels !== 2)
  ) {
    fail(
      "INVALID_OPTIONS",
      "INVALID_TRIM_ANALYSIS_OPTIONS",
      "Invalid native audio trim analysis options.",
    );
  }

  const missingFeature = !inventory.muxers.includes("framemd5")
    ? "framemd5"
    : !inventory.encoders.includes("pcm_f32le")
      ? "pcm_f32le"
      : undefined;

  if (missingFeature !== undefined) {
    fail(
      "UNSUPPORTED_CAPABILITY",
      "MISSING_TRIM_ANALYSIS_FEATURE",
      `Native audio trim analysis requires ${missingFeature}.`,
    );
  }

  let result;

  try {
    result = await run({
      executable: tools.ffmpeg.path,
      cwd: configuration.cwd,
      signal: context.signal,
      maxOutputBytes: 1_048_576,
      args: [
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-xerror",
        ...filters.inputArgs,
        "-protocol_whitelist",
        "file",
        "-i",
        inputPath,
        "-map",
        `0:${streamIndex}`,
        "-vn",
        "-sn",
        "-dn",
        "-c:a",
        "pcm_f32le",
        "-ac:a",
        String(channels),
        "-af",
        filters.audio,
        "-f",
        "framemd5",
        "pipe:1",
      ],
    });
  } catch (cause) {
    const reason = cause instanceof NativeProcessError ? cause.reason : "PROCESS_FAILED";

    fail(
      reason === "CANCELLED"
        ? "CANCELLED"
        : reason === "OUTPUT_LIMIT"
          ? "RESOURCE_LIMIT"
          : "EXECUTION_FAILED",
      reason,
      "Native audio trim analysis failed.",
      cause,
    );
  }

  checkAbort();

  if (result.stderr.trim() !== "") {
    fail(
      "EXECUTION_FAILED",
      "TRIM_ANALYSIS_DIAGNOSTIC",
      "FFmpeg reported an error during audio trim analysis.",
    );
  }

  const audioSamples = parseNativeTrimCount(
    result.stdout,
    { kind: "audio", channels },
    context.jobId,
  );

  if (audioSamples === 0) {
    throw createMavioError(
      "INVALID_OPTIONS",
      "The requested trim contains no selected audio samples.",
      {
        stage: "preparing",
        operation: "trim",
        jobId: context.jobId,
        details: { reason: "RANGE_TOO_SHORT", streamKind: "audio" },
      },
    );
  }

  return Object.freeze({ audioSamples });
}
