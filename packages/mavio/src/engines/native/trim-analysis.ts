import { posix, win32 } from "node:path";
import type { EngineContext } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import type { NativeConfiguration } from "./config.js";
import type { NativeInventory } from "./inventory.js";
import type { PreparedNativeTools } from "./prepare.js";
import { NativeProcessError, runNativeProcess } from "./process.js";
import { parseNativeTrimCount } from "./trim-counts.js";
import type { NativeTrimFilters } from "./trim-filters.js";
import { validateNativeTrimSelection, type NativeTrimSelection } from "./trim-selection.js";

interface AnalysisOptions {
  configuration: NativeConfiguration;
  tools: PreparedNativeTools;
  inventory: NativeInventory;
  /** Already-probed local input, including staged byte inputs. */
  inputPath: string;
  videoStreamIndex: number;
  audio?: {
    readonly streamIndex: number;
    readonly channels: number;
  };
  filters: NativeTrimFilters;
  context: Pick<EngineContext, "jobId" | "signal">;
}

export async function analyzeNativeTrimSelection(
  options: AnalysisOptions,
  dependencies: { run?: typeof runNativeProcess } = {},
): Promise<NativeTrimSelection> {
  const { configuration, tools, inventory, inputPath, videoStreamIndex, audio, filters, context } =
    options;
  const run = dependencies.run ?? runNativeProcess;

  function checkAbort(): void {
    if (context.signal.aborted) {
      throw createMavioError("CANCELLED", "Native trim analysis was cancelled.", {
        stage: "preparing",
        operation: "trim",
        jobId: context.jobId,
        cause: context.signal.reason,
      });
    }
  }

  checkAbort();

  const paths = configuration.platform === "win32" ? win32 : posix;
  const validIndex = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

  if (
    !paths.isAbsolute(inputPath) ||
    inputPath.includes("\0") ||
    (configuration.platform === "win32" && paths.parse(inputPath).root.length <= 1) ||
    !validIndex(videoStreamIndex) ||
    (audio !== undefined &&
      (!validIndex(audio.streamIndex) ||
        audio.streamIndex === videoStreamIndex ||
        (audio.channels !== 1 && audio.channels !== 2) ||
        filters.audio === undefined))
  ) {
    throw createMavioError("INVALID_OPTIONS", "Invalid native trim analysis options.", {
      stage: "preparing",
      operation: "trim",
      jobId: context.jobId,
      details: { reason: "INVALID_TRIM_ANALYSIS_OPTIONS" },
    });
  }

  const missingFeature = !inventory.muxers.includes("framemd5")
    ? "framemd5"
    : !inventory.encoders.includes("rawvideo")
      ? "rawvideo"
      : audio !== undefined && !inventory.encoders.includes("pcm_f32le")
        ? "pcm_f32le"
        : undefined;

  if (missingFeature !== undefined) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The installed FFmpeg build cannot analyze trim selection.",
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

  async function inspect(outputArgs: readonly string[]): Promise<string> {
    checkAbort();

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
          ...outputArgs,
          "-f",
          "framemd5",
          "pipe:1",
        ],
      });
    } catch (cause) {
      const reason = cause instanceof NativeProcessError ? cause.reason : "PROCESS_FAILED";

      throw createMavioError(
        reason === "CANCELLED"
          ? "CANCELLED"
          : reason === "OUTPUT_LIMIT"
            ? "RESOURCE_LIMIT"
            : "EXECUTION_FAILED",
        "Native trim selection analysis failed.",
        {
          stage: "preparing",
          operation: "trim",
          jobId: context.jobId,
          details: { reason, tool: "ffmpeg" },
          cause,
        },
      );
    }

    checkAbort();

    if (result.stderr.trim() !== "") {
      throw createMavioError("EXECUTION_FAILED", "FFmpeg reported an error during trim analysis.", {
        stage: "preparing",
        operation: "trim",
        jobId: context.jobId,
        details: { reason: "TRIM_ANALYSIS_DIAGNOSTIC" },
      });
    }

    return result.stdout;
  }

  const videoReport = await inspect([
    "-map",
    `0:${videoStreamIndex}`,
    "-an",
    "-c:v",
    "rawvideo",
    "-pix_fmt",
    "+yuv420p",
    "-fps_mode:v",
    "passthrough",
    "-vf",
    filters.video,
  ]);

  const videoFrames = parseNativeTrimCount(videoReport, { kind: "video" }, context.jobId);

  let audioSamples: number | undefined;

  if (audio !== undefined) {
    const audioReport = await inspect([
      "-map",
      `0:${audio.streamIndex}`,
      "-vn",
      "-c:a",
      "pcm_f32le",
      "-ac:a",
      String(audio.channels),
      "-af",
      filters.audio!,
    ]);

    audioSamples = parseNativeTrimCount(
      audioReport,
      { kind: "audio", channels: audio.channels },
      context.jobId,
    );
  }

  checkAbort();

  const selection = Object.freeze({
    videoFrames,
    ...(audioSamples === undefined ? {} : { audioSamples }),
  });

  validateNativeTrimSelection(selection, audio !== undefined, context.jobId);
  return selection;
}
