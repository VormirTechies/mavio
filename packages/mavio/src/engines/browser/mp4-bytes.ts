import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type {
  EngineContext,
  MediaMetadata as MavioMediaMetadata,
  MavioError,
  ProcessingPlan,
} from "../../contracts.js";
import { createMavioError, getErrorCode } from "../../core/errors.js";
import { prepareBrowserInput } from "./input.js";
import type { BrowserInventory } from "./inventory.js";
import { executeBrowserMp4File } from "./mp4-execution.js";
import { validateBrowserMp4Output } from "./mp4-output.js";
import { validateBrowserMp4Source } from "./mp4-source.js";
import { parseBrowserProbeDetails } from "./probe-details.js";
import { runBrowserWorkerCall } from "./worker-call.js";
import { createBrowserWorkspace } from "./workspace.js";
import { buildBrowserTrimPlan } from "./trim-plan.js";
import { analyzeBrowserTrimSelection } from "./trim-analysis.js";
import { buildBrowserResizePlan } from "./resize-plan.js";

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
  execute?: typeof executeBrowserMp4File;
  analyze?: typeof analyzeBrowserTrimSelection;
}

/**
 * Runs inside the client's serial queue.
 * Owns staging and cleanup, but does not grant publication.
 */
export async function prepareBrowserMp4Bytes(
  worker: PreparationWorker,
  plan: ProcessingPlan,
  inventory: BrowserInventory,
  context: EngineContext,
  dependencies: Dependencies = {},
): Promise<{ bytes: Uint8Array; metadata: MavioMediaMetadata }> {
  function checkAbort(): void {
    if (context.signal.aborted) {
      throw createMavioError("CANCELLED", "Browser MP4 preparation was cancelled.", {
        stage: "preparing",
        jobId: context.jobId,
        cause: context.signal.reason,
      });
    }
  }

  checkAbort();

  if (
    plan.output.kind !== "bytes" ||
    plan.terminal.type !== "export" ||
    plan.terminal.format !== "mp4" ||
    (plan.terminal.preset !== "video-balanced-v1" && plan.terminal.preset !== "video-small-v1")
  ) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "This preparation route requires MP4 byte output.",
      { stage: "preparing", jobId: context.jobId },
    );
  }

  const preset = plan.terminal.preset;

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
          stage: "preparing",
          jobId: context.jobId,
          details: { reason: "STALE_PROBE_OUTPUT" },
        });
      }

      const code = await call(() =>
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
          stage: "preparing",
          jobId: context.jobId,
        });
      }

      await call(() => worker.deleteFile(workspace.probePath));

      return parseBrowserProbeDetails(text, code, context.jobId);
    }

    await call(() => worker.writeFile(workspace.inputPath, inputBytes));

    const source = await probe(workspace.inputPath);
    const selected = validateBrowserMp4Source(source, inventory, preset);

    const video = source.metadata.streams.find(
      (stream) => stream.index === selected.videoStreamIndex,
    )!;

    const resize = buildBrowserResizePlan(
      {
        width: video.width!,
        height: video.height!,
      },
      plan.transformations,
      inventory,
    );

    const audio = source.metadata.streams.find(
      (stream) => stream.index === selected.audioStreamIndex,
    );

    const audioDetails = source.streams.find(
      (stream) => stream.index === selected.audioStreamIndex,
    );

    const outputPath = `${workspace.directory}/output.mp4`;

    const trim = buildBrowserTrimPlan(
      plan.transformations,
      source.metadata.durationSeconds,
      source.formatStartTimeSeconds,
      selected.audioStreamIndex !== undefined,
      inventory,
    );

    if (trim !== undefined) {
      checkAbort();

      await (dependencies.analyze ?? analyzeBrowserTrimSelection)(
        worker,
        {
          inputPath: workspace.inputPath,
          videoStreamIndex: selected.videoStreamIndex,
          ...(audio === undefined
            ? {}
            : {
                audio: {
                  streamIndex: audio.index,
                  channels: audio.channels!,
                },
              }),
          filters: trim,
          inventory,
        },
        context,
      );

      checkAbort();
    }

    context.reportProgress({ stage: "running" });
    checkAbort();

    await (dependencies.execute ?? executeBrowserMp4File)(
      worker,
      {
        plan,
        source,
        inventory,
        inputPath: workspace.inputPath,
        outputPath,
      },
      context,
    );

    context.reportProgress({ stage: "finalizing" });
    checkAbort();

    let output;

    try {
      output = await probe(outputPath);
    } catch (cause) {
      if (context.signal.aborted) throw cause;

      throw createMavioError("EXECUTION_FAILED", "The encoded browser MP4 could not be probed.", {
        stage: "finalizing",
        jobId: context.jobId,
        cause,
        details: { reason: "INVALID_ENCODED_PROBE" },
      });
    }

    const read = await call(() => worker.readFile(outputPath));

    if (!(read instanceof Uint8Array)) {
      throw createMavioError("EXECUTION_FAILED", "Expected binary MP4 output.", {
        stage: "finalizing",
        jobId: context.jobId,
      });
    }

    validateBrowserMp4Output(
      output,
      {
        width: resize?.dimensions.width ?? video.width!,
        height: resize?.dimensions.height ?? video.height!,
        preset,
        ...(audio === undefined
          ? {}
          : {
              audio: {
                sampleRate: audio.sampleRate!,
                channels: audio.channels!,
                channelLayout: audioDetails!.channelLayout!,
              },
            }),
      },
      read,
      context.jobId,
    );

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
      "Browser MP4 preparation failed.",
      {
        stage: primary?.stage ?? "preparing",
        jobId: context.jobId,
        cause,
        details: primary?.details,
        cleanupIssues: cleanupIssues.length ? cleanupIssues : undefined,
      },
    );
  }
}
