import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type { EngineContext, MavioError } from "../../contracts.js";
import { createMavioError, getErrorCode } from "../../core/errors.js";
import { parseNativeTrimCount } from "../shared/trim-counts.js";
import type { BrowserAudioTrimPlan } from "./audio-trim-plan.js";
import type { BrowserInventory } from "./inventory.js";
import { runBrowserWorkerCall } from "./worker-call.js";

type AnalysisWorker = Pick<FFmpeg, "loaded" | "terminate" | "exec" | "on" | "off">;

interface AnalysisOptions {
  readonly inputPath: string;
  readonly streamIndex: number;
  readonly channels: number;
  readonly filters: BrowserAudioTrimPlan;
  readonly inventory: BrowserInventory;
}

const MAX_REPORT_BYTES = 1_048_576;

/**
 * Input must already be staged and probed.
 * Counts sample frames per channel from a completed checksum report.
 * The caller owns staging cleanup and worker reset after failure.
 */
export async function analyzeBrowserAudioTrim(
  worker: AnalysisWorker,
  options: AnalysisOptions,
  context: EngineContext,
): Promise<{ readonly audioSamples: number }> {
  if (context.signal.aborted) {
    throw createMavioError("CANCELLED", "Browser audio trim analysis was cancelled.", {
      stage: "preparing",
      operation: "trim",
      jobId: context.jobId,
      cause: context.signal.reason,
    });
  }

  const { inputPath, streamIndex, channels, filters, inventory } = options;

  if (
    typeof inputPath !== "string" ||
    !/^\/mavio-[A-Za-z0-9-]+\/input\.bin$/.test(inputPath) ||
    !Number.isSafeInteger(streamIndex) ||
    streamIndex < 0 ||
    (channels !== 1 && channels !== 2)
  ) {
    throw createMavioError("INVALID_OPTIONS", "Invalid browser audio trim analysis options.", {
      stage: "preparing",
      operation: "trim",
      jobId: context.jobId,
      details: { reason: "INVALID_TRIM_ANALYSIS_OPTIONS" },
    });
  }

  const missingFeature = !inventory.muxers.includes("framemd5")
    ? "framemd5"
    : !inventory.encoders.includes("pcm_f32le")
      ? "pcm_f32le"
      : undefined;

  if (missingFeature !== undefined) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The browser core cannot analyze audio trim selection.",
      {
        stage: "preparing",
        operation: "trim",
        jobId: context.jobId,
        details: {
          reason: "MISSING_TRIM_ANALYSIS_FEATURE",
          feature: missingFeature,
        },
      },
    );
  }

  const lines: string[] = [];
  const encoder = new TextEncoder();

  let capturedBytes = 0;
  let diagnostic = false;
  let overflowError: MavioError | undefined;
  let rejectOverflow: (reason: unknown) => void = () => {};

  const overflow = new Promise<never>((_, reject) => {
    rejectOverflow = reject;
  });

  function onLog(event: { type: string; message: string }): void {
    if (event.type === "stderr") {
      const message = event.message.trim();

      if (message !== "" && message !== "Aborted()") {
        diagnostic = true;
      }

      return;
    }

    if (event.type !== "stdout" || overflowError !== undefined) {
      return;
    }

    capturedBytes += encoder.encode(event.message).byteLength + 1;

    if (capturedBytes > MAX_REPORT_BYTES) {
      overflowError = createMavioError(
        "RESOURCE_LIMIT",
        "Browser audio trim analysis exceeded its report limit.",
        {
          stage: "preparing",
          operation: "trim",
          jobId: context.jobId,
          details: {
            reason: "TRIM_ANALYSIS_OUTPUT_LIMIT",
            limitBytes: MAX_REPORT_BYTES,
          },
        },
      );

      rejectOverflow(overflowError);
      return;
    }

    lines.push(event.message);
  }

  worker.on("log", onLog);

  try {
    const exitCode = await Promise.race([
      runBrowserWorkerCall(worker, context, () =>
        worker.exec([
          "-hide_banner",
          "-v",
          "error",
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
          "-threads:a",
          "1",
          "-af",
          filters.audio,
          "-f",
          "framemd5",
          "pipe:1",
        ]),
      ),
      overflow,
    ]);

    if (overflowError !== undefined) throw overflowError;

    if (exitCode !== 0 || diagnostic) {
      throw createMavioError(
        "EXECUTION_FAILED",
        "Browser audio trim analysis did not complete successfully.",
        {
          stage: "preparing",
          operation: "trim",
          jobId: context.jobId,
          details: {
            reason: exitCode !== 0 ? "TRIM_ANALYSIS_EXIT_FAILURE" : "TRIM_ANALYSIS_DIAGNOSTIC",
          },
        },
      );
    }

    const audioSamples = parseNativeTrimCount(
      lines.join("\n"),
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
          details: {
            reason: "RANGE_TOO_SHORT",
            streamKind: "audio",
          },
        },
      );
    }

    return Object.freeze({ audioSamples });
  } catch (cause) {
    const code = getErrorCode(cause);
    const primary = code === undefined ? undefined : (cause as MavioError);

    const cleanupIssues = [...(primary?.cleanupIssues ?? [])];

    // A report overflow can occur while exec is still pending.
    if (overflowError !== undefined && worker.loaded) {
      try {
        worker.terminate();
      } catch {
        cleanupIssues.push("Browser worker termination failed.");
      }
    }

    throw createMavioError(
      context.signal.aborted ? "CANCELLED" : (code ?? "EXECUTION_FAILED"),
      "Browser audio trim analysis failed.",
      {
        stage: "preparing",
        operation: "trim",
        jobId: context.jobId,
        cause,
        details: primary?.details,
        cleanupIssues: cleanupIssues.length ? cleanupIssues : undefined,
      },
    );
  } finally {
    worker.off("log", onLog);
  }
}
