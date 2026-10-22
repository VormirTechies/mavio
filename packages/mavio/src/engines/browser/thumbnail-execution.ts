import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type { EngineContext, MavioError } from "../../contracts.js";
import { createMavioError, getErrorCode } from "../../core/errors.js";
import { buildBrowserThumbnailCommand } from "./thumbnail-command.js";
import { runBrowserWorkerCall } from "./worker-call.js";

type ExecutionWorker = Pick<FFmpeg, "loaded" | "terminate" | "listDir" | "exec" | "on" | "off">;

/**
 * Runs inside the client's serial queue.
 * The caller owns the private workspace and its cleanup.
 * Output must still be probed and validated before publication.
 */
export async function executeBrowserThumbnailFile(
  worker: ExecutionWorker,
  options: Parameters<typeof buildBrowserThumbnailCommand>[0],
  context: EngineContext,
): Promise<void> {
  if (context.signal.aborted) {
    throw createMavioError("CANCELLED", "Browser thumbnail encoding was cancelled.", {
      stage: "preparing",
      jobId: context.jobId,
      cause: context.signal.reason,
    });
  }

  // Validate before accessing the worker filesystem.
  const args = buildBrowserThumbnailCommand(options);

  const separator = options.outputPath.lastIndexOf("/");
  const directory = options.outputPath.slice(0, separator);
  const filename = options.outputPath.slice(separator + 1);

  async function inspect(stage: "preparing" | "finalizing") {
    try {
      return await runBrowserWorkerCall(worker, context, () => worker.listDir(directory));
    } catch (cause) {
      const cancelled = context.signal.aborted || getErrorCode(cause) === "CANCELLED";

      const primary = cause instanceof Error ? (cause as Partial<MavioError>) : undefined;

      throw createMavioError(
        cancelled ? "CANCELLED" : "IO_ERROR",
        "Could not inspect the browser thumbnail output directory.",
        {
          stage,
          jobId: context.jobId,
          cause,
          cleanupIssues: primary?.cleanupIssues,
          details: cancelled ? undefined : { reason: "OUTPUT_INSPECTION_FAILED" },
        },
      );
    }
  }

  const before = await inspect("preparing");

  if (before.some((entry) => entry.name === filename)) {
    throw createMavioError(
      "OUTPUT_EXISTS",
      "The browser thumbnail intermediate output already exists.",
      {
        stage: "preparing",
        jobId: context.jobId,
        details: {
          reason: "INTERMEDIATE_OUTPUT_EXISTS",
        },
      },
    );
  }

  let errorDiagnostic = false;

  function onLog(event: { type: string; message: string }): void {
    if (event.type !== "stderr") return;

    const message = event.message.trim();

    // Preserve the existing narrowly scoped pinned-core handling.
    if (message === "" || message === "Aborted()") return;

    errorDiagnostic = true;
  }

  worker.on("log", onLog);

  let exitCode: number;

  try {
    exitCode = await runBrowserWorkerCall(worker, context, () => worker.exec([...args]));
  } catch (cause) {
    const cancelled = context.signal.aborted || getErrorCode(cause) === "CANCELLED";

    const primary = cause instanceof Error ? (cause as Partial<MavioError>) : undefined;

    throw createMavioError(
      cancelled ? "CANCELLED" : "EXECUTION_FAILED",
      "Browser thumbnail encoding did not complete.",
      {
        stage: "running",
        jobId: context.jobId,
        cause,
        cleanupIssues: primary?.cleanupIssues,
      },
    );
  } finally {
    worker.off("log", onLog);
  }

  if (exitCode !== 0 || errorDiagnostic) {
    throw createMavioError(
      "EXECUTION_FAILED",
      `Browser thumbnail encoding failed (exit ${exitCode}, error diagnostic ${errorDiagnostic}).`,
      {
        stage: "running",
        jobId: context.jobId,
        details: {
          reason: exitCode !== 0 ? "ENCODER_EXIT_FAILURE" : "ENCODER_ERROR_DIAGNOSTIC",
        },
      },
    );
  }

  const after = await inspect("finalizing");
  const output = after.find((entry) => entry.name === filename);

  if (output === undefined || output.isDir) {
    throw createMavioError(
      "EXECUTION_FAILED",
      "Browser thumbnail encoding did not create the expected file.",
      {
        stage: "finalizing",
        jobId: context.jobId,
        details: {
          reason: "INVALID_ENCODED_OUTPUT",
        },
      },
    );
  }
}
