import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type { EngineContext, MavioError } from "../../contracts.js";
import { createMavioError, getErrorCode } from "../../core/errors.js";
import { parseNativeTrimCount } from "../shared/trim-counts.js";
import type { BrowserInventory } from "./inventory.js";
import type { buildBrowserThumbnailPlan } from "./thumbnail-plan.js";
import { runBrowserWorkerCall } from "./worker-call.js";

type AnalysisWorker = Pick<FFmpeg, "loaded" | "terminate" | "exec" | "on" | "off">;

interface AnalysisOptions {
  readonly inputPath: string;
  readonly selection: ReturnType<typeof buildBrowserThumbnailPlan>;
  readonly inventory: BrowserInventory;
}

const MAX_REPORT_BYTES = 1_048_576;

/**
 * Input is already staged and probed.
 * Confirms that one frame exists in the planned selection interval.
 * The caller owns workspace cleanup and worker reset after failure.
 */
export async function analyzeBrowserThumbnail(
  worker: AnalysisWorker,
  options: AnalysisOptions,
  context: EngineContext,
): Promise<{ readonly videoFrames: number }> {
  if (context.signal.aborted) {
    throw createMavioError("CANCELLED", "Browser thumbnail analysis was cancelled.", {
      stage: "preparing",
      operation: "thumbnail",
      jobId: context.jobId,
      cause: context.signal.reason,
    });
  }

  const { inputPath, selection, inventory } = options;
  const streamIndex = selection.source.videoStreamIndex;

  if (
    typeof inputPath !== "string" ||
    !/^\/mavio-[A-Za-z0-9-]+\/input\.bin$/.test(inputPath) ||
    !Number.isSafeInteger(streamIndex) ||
    streamIndex < 0
  ) {
    throw createMavioError("INVALID_OPTIONS", "Invalid browser thumbnail analysis options.", {
      stage: "preparing",
      operation: "thumbnail",
      jobId: context.jobId,
      details: { reason: "INVALID_THUMBNAIL_ANALYSIS_OPTIONS" },
    });
  }

  const missingFeature = !inventory.muxers.includes("framemd5")
    ? "framemd5"
    : !inventory.encoders.includes("rawvideo")
      ? "rawvideo"
      : undefined;

  if (missingFeature !== undefined) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "Browser thumbnail selection analysis is unavailable.",
      {
        stage: "preparing",
        operation: "thumbnail",
        jobId: context.jobId,
        details: {
          reason: "MISSING_THUMBNAIL_ANALYSIS_FEATURE",
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
        "Browser thumbnail analysis exceeded its report limit.",
        {
          stage: "preparing",
          operation: "thumbnail",
          jobId: context.jobId,
          details: {
            reason: "THUMBNAIL_ANALYSIS_OUTPUT_LIMIT",
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
          ...selection.inputArgs,
          "-noautorotate",
          "-filter_threads",
          "1",
          "-protocol_whitelist",
          "file",
          "-i",
          inputPath,
          "-map",
          `0:${streamIndex}`,
          "-an",
          "-sn",
          "-dn",
          "-vf",
          selection.video,
          "-c:v",
          "rawvideo",
          "-pix_fmt",
          "+yuv420p",
          "-threads:v",
          "1",
          "-fps_mode:v",
          "passthrough",
          "-frames:v",
          "1",
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
        "Browser thumbnail analysis did not complete successfully.",
        {
          stage: "preparing",
          operation: "thumbnail",
          jobId: context.jobId,
          details: {
            reason:
              exitCode !== 0 ? "THUMBNAIL_ANALYSIS_EXIT_FAILURE" : "THUMBNAIL_ANALYSIS_DIAGNOSTIC",
          },
        },
      );
    }

    const videoFrames = parseNativeTrimCount(lines.join("\n"), { kind: "video" }, context.jobId);

    if (videoFrames === 0) {
      throw createMavioError(
        "INVALID_OPTIONS",
        "No video frame exists in the requested interval.",
        {
          stage: "preparing",
          operation: "thumbnail",
          jobId: context.jobId,
          details: {
            reason: "RANGE_TOO_SHORT",
            streamKind: "video",
          },
        },
      );
    }

    if (videoFrames !== 1) {
      throw createMavioError(
        "EXECUTION_FAILED",
        "Thumbnail analysis returned an invalid frame count.",
        {
          stage: "preparing",
          operation: "thumbnail",
          jobId: context.jobId,
          details: { reason: "INVALID_THUMBNAIL_SELECTION" },
        },
      );
    }

    return Object.freeze({ videoFrames });
  } catch (cause) {
    const code = getErrorCode(cause);
    const primary = code === undefined ? undefined : (cause as MavioError);

    const cleanupIssues = [...(primary?.cleanupIssues ?? [])];

    if (overflowError !== undefined && worker.loaded) {
      try {
        worker.terminate();
      } catch {
        cleanupIssues.push("Browser worker termination failed.");
      }
    }

    throw createMavioError(
      context.signal.aborted ? "CANCELLED" : (code ?? "EXECUTION_FAILED"),
      "Browser thumbnail analysis failed.",
      {
        stage: "preparing",
        operation: "thumbnail",
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
