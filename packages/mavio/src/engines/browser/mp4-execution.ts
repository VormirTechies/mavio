import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type { EngineContext, MavioError } from "../../contracts.js";
import { createMavioError, getErrorCode } from "../../core/errors.js";
import { buildBrowserMp4Command } from "./mp4-command.js";
import { runBrowserWorkerCall } from "./worker-call.js";

type ExecutionWorker = Pick<FFmpeg, "loaded" | "terminate" | "listDir" | "exec" | "on" | "off">;

/**
 * Must run inside the client's serial queue.
 * The output must be in the caller's private workspace.
 *
 * This verifies command completion and output-file presence.
 * The caller must probe and validate the output before returning it.
 */
export async function executeBrowserMp4File(
  worker: ExecutionWorker,
  options: Parameters<typeof buildBrowserMp4Command>[0],
  context: EngineContext,
): Promise<void> {
  if (context.signal.aborted) {
    throw createMavioError("CANCELLED", "Browser encoding was cancelled.", {
      stage: "preparing",
      jobId: context.jobId,
      cause: context.signal.reason,
    });
  }

  const args = buildBrowserMp4Command(options);
  const directory = options.outputPath.slice(0, options.outputPath.lastIndexOf("/"));

  async function inspect() {
    try {
      return await runBrowserWorkerCall(worker, context, () => worker.listDir(directory));
    } catch (cause) {
      if (getErrorCode(cause) === "CANCELLED") throw cause;

      throw createMavioError("IO_ERROR", "Could not inspect the browser output directory.", {
        stage: "preparing",
        jobId: context.jobId,
        details: { reason: "OUTPUT_INSPECTION_FAILED" },
        cause,
      });
    }
  }

  const before = await inspect();

  if (before.some((entry) => entry.name === "output.mp4")) {
    throw createMavioError("OUTPUT_EXISTS", "The browser intermediate output already exists.", {
      stage: "preparing",
      jobId: context.jobId,
      details: { reason: "INTERMEDIATE_OUTPUT_EXISTS" },
    });
  }

  let errorDiagnostic = false;

  function onLog(event: { type: string; message: string }): void {
    if (event.type !== "stderr") return;

    const message = event.message.trim();

    // Pinned @ffmpeg/core@0.12.10 can emit this exact control-flow marker.
    // Other abort messages and genuine diagnostics remain failures.
    if (message === "" || message === "Aborted()") return;

    errorDiagnostic = true;
  }

  worker.on("log", onLog);

  let exitCode: number;

  try {
    exitCode = await runBrowserWorkerCall(worker, context, () => worker.exec([...args]));
  } catch (cause) {
    const cancelled = getErrorCode(cause) === "CANCELLED";
    const primary = cause instanceof Error ? (cause as Partial<MavioError>) : undefined;

    throw createMavioError(
      cancelled ? "CANCELLED" : "EXECUTION_FAILED",
      "Browser MP4 encoding did not complete.",
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
      `Browser FFmpeg reported an encoding failure (exit ${exitCode}, error diagnostic ${errorDiagnostic}).`,
      {
        stage: "running",
        jobId: context.jobId,
        details: {
          reason: exitCode !== 0 ? "ENCODER_EXIT_FAILURE" : "ENCODER_ERROR_DIAGNOSTIC",
        },
      },
    );
  }

  const after = await inspect();
  const output = after.find((entry) => entry.name === "output.mp4");

  if (output === undefined || output.isDir) {
    throw createMavioError(
      "EXECUTION_FAILED",
      "Browser FFmpeg did not create the expected output file.",
      {
        stage: "finalizing",
        jobId: context.jobId,
        details: { reason: "INVALID_ENCODED_OUTPUT" },
      },
    );
  }
}
