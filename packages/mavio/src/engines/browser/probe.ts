import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type { EngineContext, MediaInput, MediaMetadata, MavioError } from "../../contracts.js";
import { createMavioError, getErrorCode } from "../../core/errors.js";
import { prepareBrowserInput } from "./input.js";
import { parseBrowserProbeDetails, type BrowserProbeDetails } from "./probe-details.js";
import { runBrowserWorkerCall } from "./worker-call.js";
import { createBrowserWorkspace } from "./workspace.js";

type ProbeWorker = Pick<
  FFmpeg,
  | "loaded"
  | "terminate"
  | "createDir"
  | "listDir"
  | "deleteFile"
  | "deleteDir"
  | "writeFile"
  | "readFile"
  | "ffprobe"
>;

/**
 * Calls must run inside the client's serial queue.
 * Success removes the workspace and retains the worker.
 * Failure discards the worker and its entire virtual filesystem.
 */
export async function probeBrowserInputDetails(
  worker: ProbeWorker,
  input: MediaInput,
  context: EngineContext,
): Promise<BrowserProbeDetails> {
  if (context.signal.aborted) {
    throw createMavioError("CANCELLED", "Browser metadata was cancelled.", {
      stage: "preparing",
      jobId: context.jobId,
      cause: context.signal.reason,
    });
  }

  function call<T>(operation: () => Promise<T>): Promise<T> {
    return runBrowserWorkerCall(worker, context, operation);
  }

  try {
    const bytes = await prepareBrowserInput(input, context);

    // Guard each filesystem operation separately, including cleanup.
    const workspace = await createBrowserWorkspace(
      {
        createDir: (path) => call(() => worker.createDir(path)),
        listDir: (path) => call(() => worker.listDir(path)),
        deleteFile: (path) => call(() => worker.deleteFile(path)),
        deleteDir: (path) => call(() => worker.deleteDir(path)),
      },
      context.jobId,
    );

    await call(() => worker.writeFile(workspace.inputPath, bytes));

    const entries = await call(() => worker.listDir(workspace.directory));

    if (entries.some((entry) => entry.name === "probe.json")) {
      throw createMavioError(
        "EXECUTION_FAILED",
        "Browser probe output already exists before execution.",
        {
          stage: "preparing",
          jobId: context.jobId,
          details: { reason: "STALE_PROBE_OUTPUT" },
        },
      );
    }

    const exitCode = await call(() =>
      worker.ffprobe([
        "-v",
        "error",
        "-show_error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        workspace.inputPath,
        "-o",
        workspace.probePath,
      ]),
    );

    const text = await call(() => worker.readFile(workspace.probePath, "utf8"));

    if (typeof text !== "string") {
      throw createMavioError("EXECUTION_FAILED", "Browser probe output was not text.", {
        stage: "preparing",
        jobId: context.jobId,
        details: { reason: "INVALID_PROBE_OUTPUT_TYPE" },
      });
    }

    const metadata = parseBrowserProbeDetails(text, exitCode, context.jobId);

    await workspace.cleanup();

    return metadata;
  } catch (cause) {
    const code = getErrorCode(cause);
    const primary = code === undefined ? undefined : (cause as MavioError);
    const cleanupIssues = [...(primary?.cleanupIssues ?? [])];

    // A terminated worker has already discarded its virtual filesystem.
    if (worker.loaded) {
      try {
        worker.terminate();
      } catch {
        cleanupIssues.push("Browser worker termination failed.");
      }
    }

    throw createMavioError(
      context.signal.aborted ? "CANCELLED" : (code ?? "EXECUTION_FAILED"),
      context.signal.aborted
        ? "Browser metadata was cancelled."
        : "Browser metadata probing failed.",
      {
        stage: primary?.stage ?? "preparing",
        jobId: context.jobId,
        cause,
        details: primary?.details,
        cleanupIssues: cleanupIssues.length === 0 ? undefined : cleanupIssues,
      },
    );
  }
}

export async function probeBrowserInput(
  worker: ProbeWorker,
  input: MediaInput,
  context: EngineContext,
): Promise<MediaMetadata> {
  return (await probeBrowserInputDetails(worker, input, context)).metadata;
}
