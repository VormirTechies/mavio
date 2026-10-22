import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type {
  EngineContext,
  MediaMetadata as MavioMediaMetadata,
  MavioError,
  ProcessingPlan,
} from "../../contracts.js";
import { createMavioError, getErrorCode } from "../../core/errors.js";
import { buildThumbnailResize } from "../shared/thumbnail-resize.js";
import { prepareBrowserInput } from "./input.js";
import type { BrowserInventory } from "./inventory.js";
import { parseBrowserProbeDetails } from "./probe-details.js";
import { analyzeBrowserThumbnail } from "./thumbnail-analysis.js";
import { buildBrowserThumbnailCommand } from "./thumbnail-command.js";
import { executeBrowserThumbnailFile } from "./thumbnail-execution.js";
import { validateBrowserThumbnailOutput } from "./thumbnail-output.js";
import { buildBrowserThumbnailPlan } from "./thumbnail-plan.js";
import { runBrowserWorkerCall } from "./worker-call.js";
import { createBrowserWorkspace } from "./workspace.js";

type PreparationWorker = Pick<
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
  | "exec"
  | "on"
  | "off"
>;

interface Dependencies {
  execute?: typeof executeBrowserThumbnailFile;
  analyze?: typeof analyzeBrowserThumbnail;
}

/**
 * Runs inside the client's serial queue.
 * Owns staging and cleanup, but never requests publication.
 * On failure, the worker is discarded to release its private filesystem.
 */
export async function prepareBrowserThumbnailBytes(
  worker: PreparationWorker,
  plan: ProcessingPlan,
  inventory: BrowserInventory,
  context: EngineContext,
  dependencies: Dependencies = {},
): Promise<{ bytes: Uint8Array; metadata: MavioMediaMetadata }> {
  let stage: "preparing" | "running" | "finalizing" = "preparing";

  function checkAbort(): void {
    if (context.signal.aborted) {
      throw createMavioError("CANCELLED", "Browser audio preparation was cancelled.", {
        stage,
        jobId: context.jobId,
        cause: context.signal.reason,
      });
    }
  }

  // Cancellation before admission must not disturb an existing worker.
  checkAbort();

  if (
    plan.output.kind !== "bytes" ||
    plan.terminal.type !== "thumbnail" ||
    (plan.terminal.preset !== "jpeg-balanced-v1" && plan.terminal.preset !== "png-lossless-v1")
  ) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "This preparation route requires audio byte output.",
      {
        stage,
        jobId: context.jobId,
        details: { reason: "UNSUPPORTED_BROWSER_ENCODING" },
      },
    );
  }

  const preset = plan.terminal.preset;
  const format = preset === "jpeg-balanced-v1" ? "jpeg" : "png";

  function call<T>(operation: () => Promise<T>): Promise<T> {
    return runBrowserWorkerCall(worker, context, operation);
  }

  try {
    const inputBytes = await prepareBrowserInput(plan.input, context);

    const workspace = await createBrowserWorkspace(
      {
        createDir: (path) => call(() => worker.createDir(path)),
        listDir: (path) => call(() => worker.listDir(path)),
        deleteFile: (path) => call(() => worker.deleteFile(path)),
        deleteDir: (path) => call(() => worker.deleteDir(path)),
      },
      context.jobId,
    );

    async function probe(path: string) {
      const entries = await call(() => worker.listDir(workspace.directory));

      if (entries.some((entry) => entry.name === "probe.json")) {
        throw createMavioError("EXECUTION_FAILED", "Probe output must be fresh.", {
          stage,
          jobId: context.jobId,
          details: { reason: "STALE_PROBE_OUTPUT" },
        });
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
          path,
          "-o",
          workspace.probePath,
        ]),
      );

      const text = await call(() => worker.readFile(workspace.probePath, "utf8"));

      if (typeof text !== "string") {
        throw createMavioError("EXECUTION_FAILED", "Browser probe output was not text.", {
          stage,
          jobId: context.jobId,
        });
      }

      await call(() => worker.deleteFile(workspace.probePath));

      return parseBrowserProbeDetails(text, exitCode, context.jobId);
    }

    await call(() => worker.writeFile(workspace.inputPath, inputBytes));

    const source = await probe(workspace.inputPath);
    const outputPath = `${workspace.directory}/output.${format}`;

    const commandOptions = {
      plan,
      source,
      inventory,
      inputPath: workspace.inputPath,
      outputPath,
    };

    // Validate the complete route even when execution is injected.
    buildBrowserThumbnailCommand(commandOptions);

    const selection = buildBrowserThumbnailPlan(
      source,
      plan.transformations,
      plan.terminal.at,
      inventory,
    );

    const resize = buildThumbnailResize(selection.source, plan.transformations, preset, inventory);

    checkAbort();

    const evidence = await (dependencies.analyze ?? analyzeBrowserThumbnail)(
      worker,
      {
        inputPath: workspace.inputPath,
        selection,
        inventory,
      },
      context,
    );

    checkAbort();

    if (evidence.videoFrames === 0) {
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

    if (evidence.videoFrames !== 1) {
      throw createMavioError(
        "EXECUTION_FAILED",
        "Thumbnail analysis returned invalid selection evidence.",
        {
          stage: "preparing",
          operation: "thumbnail",
          jobId: context.jobId,
          details: { reason: "INVALID_THUMBNAIL_SELECTION" },
        },
      );
    }

    stage = "running";
    context.reportProgress({ stage });
    checkAbort();

    await (dependencies.execute ?? executeBrowserThumbnailFile)(worker, commandOptions, context);

    stage = "finalizing";
    context.reportProgress({ stage });
    checkAbort();

    let output;

    try {
      output = await probe(outputPath);
    } catch (cause) {
      if (context.signal.aborted) throw cause;

      throw createMavioError("EXECUTION_FAILED", "The encoded browser audio could not be probed.", {
        stage,
        jobId: context.jobId,
        cause,
        details: { reason: "INVALID_ENCODED_PROBE" },
      });
    }

    const read = await call(() => worker.readFile(outputPath));

    if (!(read instanceof Uint8Array)) {
      throw createMavioError("EXECUTION_FAILED", "Expected binary audio output.", {
        stage,
        jobId: context.jobId,
        details: { reason: "INVALID_ENCODED_OUTPUT" },
      });
    }

    validateBrowserThumbnailOutput(
      output,
      {
        preset,
        width: resize.dimensions.width,
        height: resize.dimensions.height,
      },
      read,
      context.jobId,
    );

    // Never expose storage owned by the worker or its filesystem.
    const bytes = new Uint8Array(read);
    const metadata = structuredClone(output.metadata);

    await workspace.cleanup();
    checkAbort();

    return { bytes, metadata };
  } catch (cause) {
    const code = getErrorCode(cause);
    const primary = code === undefined ? undefined : (cause as MavioError);

    const cleanupIssues = [...(primary?.cleanupIssues ?? [])];

    if (worker.loaded) {
      try {
        worker.terminate();
      } catch {
        cleanupIssues.push("Browser worker termination failed.");
      }
    }

    throw createMavioError(
      context.signal.aborted ? "CANCELLED" : (code ?? "EXECUTION_FAILED"),
      "Browser audio preparation failed.",
      {
        stage: primary?.stage ?? stage,
        jobId: context.jobId,
        cause,
        details: primary?.details,
        cleanupIssues: cleanupIssues.length ? cleanupIssues : undefined,
      },
    );
  }
}
