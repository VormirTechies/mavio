import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type { EngineContext, MavioError } from "../../contracts.js";
import { createMavioError, getErrorCode } from "../../core/errors.js";
import { parseNativeTrimCount } from "../shared/trim-counts.js";
import { validateNativeTrimSelection, type NativeTrimSelection } from "../shared/trim-selection.js";
import type { BrowserInventory } from "./inventory.js";
import type { buildBrowserTrimPlan } from "./trim-plan.js";
import { runBrowserWorkerCall } from "./worker-call.js";

const MAX_AUDIO_ANALYSIS_BYTES = 64 * 1024 * 1024;

type AnalysisWorker = Pick<
  FFmpeg,
  "loaded" | "terminate" | "exec" | "on" | "off" | "listDir" | "readFile" | "deleteFile"
>;

interface AnalysisOptions {
  inputPath: string;
  videoStreamIndex: number;
  audio?: {
    readonly streamIndex: number;
    readonly channels: number;
  };
  filters: NonNullable<ReturnType<typeof buildBrowserTrimPlan>>;
  inventory: BrowserInventory;
}

/**
 * Input is already staged and probed.
 * Video counts come from bounded checksum reports.
 * Audio counts come from temporary raw float PCM.
 * The caller owns workspace cleanup and worker reset after failure.
 */
export async function analyzeBrowserTrimSelection(
  worker: AnalysisWorker,
  options: AnalysisOptions,
  context: EngineContext,
): Promise<NativeTrimSelection> {
  const { inputPath, videoStreamIndex, audio, filters, inventory } = options;

  if (context.signal.aborted) {
    throw createMavioError("CANCELLED", "Browser trim analysis was cancelled.", {
      stage: "preparing",
      operation: "trim",
      jobId: context.jobId,
      cause: context.signal.reason,
    });
  }

  const validIndex = (value: number) => Number.isSafeInteger(value) && value >= 0;

  if (
    typeof inputPath !== "string" ||
    !/^\/mavio-[A-Za-z0-9-]+\/input\.bin$/.test(inputPath) ||
    !validIndex(videoStreamIndex) ||
    (audio !== undefined &&
      (!validIndex(audio.streamIndex) ||
        audio.streamIndex === videoStreamIndex ||
        (audio.channels !== 1 && audio.channels !== 2) ||
        filters.audio === undefined))
  ) {
    throw createMavioError("INVALID_OPTIONS", "Invalid browser trim analysis options.", {
      stage: "preparing",
      operation: "trim",
      jobId: context.jobId,
      details: {
        reason: "INVALID_TRIM_ANALYSIS_OPTIONS",
      },
    });
  }

  const missingFeature = !inventory.muxers.includes("framemd5")
    ? "framemd5"
    : !inventory.encoders.includes("rawvideo")
      ? "rawvideo"
      : audio !== undefined && !inventory.encoders.includes("pcm_f32le")
        ? "pcm_f32le"
        : audio !== undefined && !inventory.muxers.includes("f32le")
          ? "f32le"
          : undefined;

  if (missingFeature !== undefined) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The browser core cannot analyze trim selection.",
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

  async function inspect(
    outputArgs: readonly string[],
    format = "framemd5",
    destination = "pipe:1",
  ): Promise<string> {
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

      if (capturedBytes > 1_048_576) {
        overflowError = createMavioError(
          "RESOURCE_LIMIT",
          "Browser trim analysis output exceeded its limit.",
          {
            stage: "preparing",
            operation: "trim",
            jobId: context.jobId,
            details: {
              reason: "TRIM_ANALYSIS_OUTPUT_LIMIT",
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
      const code = await Promise.race([
        runBrowserWorkerCall(worker, context, () =>
          worker.exec([
            "-hide_banner",
            "-v",
            "error",
            "-xerror",
            ...filters.inputArgs,
            "-noautorotate",
            "-protocol_whitelist",
            "file",
            "-i",
            inputPath,
            ...outputArgs,
            "-f",
            format,
            destination,
          ]),
        ),
        overflow,
      ]);

      if (overflowError !== undefined) {
        throw overflowError;
      }

      if (code !== 0 || diagnostic) {
        throw createMavioError(
          "EXECUTION_FAILED",
          "Browser trim analysis did not complete successfully.",
          {
            stage: "preparing",
            operation: "trim",
            jobId: context.jobId,
            details: {
              reason: code !== 0 ? "TRIM_ANALYSIS_EXIT_FAILURE" : "TRIM_ANALYSIS_DIAGNOSTIC",
            },
          },
        );
      }

      return lines.join("\n");
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
        "Browser trim analysis failed.",
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

  const videoReport = await inspect([
    "-map",
    `0:${videoStreamIndex}`,
    "-an",
    "-c:v",
    "rawvideo",
    "-pix_fmt",
    "+yuv420p",
    "-threads:v",
    "1",
    "-fps_mode:v",
    "passthrough",
    "-vf",
    filters.video,
  ]);

  const videoFrames = parseNativeTrimCount(videoReport, { kind: "video" }, context.jobId);

  if (videoFrames === 0) {
    throw createMavioError(
      "INVALID_OPTIONS",
      "The trim interval contains no selected video content.",
      {
        stage: "preparing",
        operation: "trim",
        jobId: context.jobId,
        details: {
          reason: "RANGE_TOO_SHORT",
          streamKind: "video",
        },
      },
    );
  }

  let audioSamples: number | undefined;

  if (audio !== undefined) {
    const directory = inputPath.slice(0, inputPath.lastIndexOf("/"));

    const filename = `trim-audio-${crypto.randomUUID()}.f32le`;

    const audioPath = `${directory}/${filename}`;

    const entries = await runBrowserWorkerCall(worker, context, () => worker.listDir(directory));

    if (entries.some((entry) => entry.name === filename)) {
      throw createMavioError("OUTPUT_EXISTS", "The audio analysis destination already exists.", {
        stage: "preparing",
        operation: "trim",
        jobId: context.jobId,
        details: {
          reason: "AUDIO_ANALYSIS_OUTPUT_EXISTS",
        },
      });
    }

    async function removeAudioOutput(): Promise<void> {
      // Termination releases the entire private worker filesystem.
      if (!worker.loaded) {
        return;
      }

      const currentEntries = await runBrowserWorkerCall(worker, context, () =>
        worker.listDir(directory),
      );

      const entry = currentEntries.find((candidate) => candidate.name === filename);

      if (entry === undefined) {
        return;
      }

      if (entry.isDir) {
        throw new Error("Audio analysis output unexpectedly became a directory.");
      }

      await runBrowserWorkerCall(worker, context, () => worker.deleteFile(audioPath));
    }

    try {
      await inspect(
        [
          "-map",
          `0:${audio.streamIndex}`,
          "-vn",
          "-c:a",
          "pcm_f32le",
          "-ac:a",
          String(audio.channels),
          "-threads:a",
          "1",
          "-af",
          filters.audio!,
          "-fs",
          String(MAX_AUDIO_ANALYSIS_BYTES),
        ],
        "f32le",
        audioPath,
      );

      const pcm = await runBrowserWorkerCall(worker, context, () => worker.readFile(audioPath));

      if (!(pcm instanceof Uint8Array)) {
        throw createMavioError(
          "EXECUTION_FAILED",
          "Audio trim analysis did not return PCM bytes.",
          {
            stage: "preparing",
            operation: "trim",
            jobId: context.jobId,
            details: {
              reason: "INVALID_TRIM_AUDIO_PCM",
            },
          },
        );
      }

      // Never accept a count from potentially truncated output.
      if (pcm.byteLength >= MAX_AUDIO_ANALYSIS_BYTES) {
        throw createMavioError(
          "RESOURCE_LIMIT",
          "Audio trim analysis reached its PCM output limit.",
          {
            stage: "preparing",
            operation: "trim",
            jobId: context.jobId,
            details: {
              reason: "TRIM_AUDIO_OUTPUT_LIMIT",
              limitBytes: MAX_AUDIO_ANALYSIS_BYTES,
            },
          },
        );
      }

      const bytesPerSampleFrame = 4 * audio.channels;

      if (pcm.byteLength % bytesPerSampleFrame !== 0) {
        throw createMavioError(
          "EXECUTION_FAILED",
          "Audio trim analysis returned incomplete PCM samples.",
          {
            stage: "preparing",
            operation: "trim",
            jobId: context.jobId,
            details: {
              reason: "INVALID_TRIM_AUDIO_PCM",
            },
          },
        );
      }

      audioSamples = pcm.byteLength / bytesPerSampleFrame;
    } catch (cause) {
      const code = getErrorCode(cause);
      const primary = code === undefined ? undefined : (cause as MavioError);

      const cleanupIssues = [...(primary?.cleanupIssues ?? [])];

      try {
        await removeAudioOutput();
      } catch (cleanupError) {
        cleanupIssues.push(
          "Temporary audio analysis cleanup failed: " +
            (cleanupError instanceof Error ? cleanupError.message : String(cleanupError)),
        );
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
    }

    try {
      await removeAudioOutput();
    } catch (cause) {
      throw createMavioError(
        context.signal.aborted ? "CANCELLED" : "CLEANUP_FAILED",
        "Temporary audio analysis cleanup failed.",
        {
          stage: "preparing",
          operation: "trim",
          jobId: context.jobId,
          cause,
          details: {
            reason: "AUDIO_ANALYSIS_CLEANUP_FAILED",
          },
        },
      );
    }
  }

  const selection = Object.freeze({
    videoFrames,
    ...(audioSamples === undefined ? {} : { audioSamples }),
  });

  validateNativeTrimSelection(selection, audio !== undefined, context.jobId);

  return selection;
}
