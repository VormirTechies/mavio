import { NATIVE_PROBE_INPUT_ARGUMENTS } from "./input-policy.js";
import { stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { EngineContext, MediaMetadata } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import type { NativeConfiguration } from "./config.js";
import type { PreparedNativeTools } from "./prepare.js";
import { NativeProcessError, runNativeProcess } from "./process.js";
import { parseNativeProbeDetails, type NativeProbeDetails } from "./probe-details.js";

interface Dependencies {
  inspect?: (path: string) => Promise<{ isFile(): boolean }>;
  run?: typeof runNativeProcess;
}

const entries = [
  "format=duration,size,format_name,bit_rate,start_time",
  "stream=index,codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels,pix_fmt,color_transfer,color_primaries,color_space,color_range,channel_layout,sample_aspect_ratio,start_time",
  "stream_tags=rotate",
  "stream_side_data=side_data_type,rotation",
  "stream_disposition=attached_pic",
].join(":");

export async function probeNativeFileDetails(
  configuration: NativeConfiguration,
  tools: PreparedNativeTools,
  inputPath: string,
  context: Pick<EngineContext, "jobId" | "signal">,
  dependencies: Dependencies = {},
): Promise<NativeProbeDetails> {
  const inspect = dependencies.inspect ?? stat;
  const run = dependencies.run ?? runNativeProcess;
  const paths = configuration.platform === "win32" ? win32 : posix;

  function checkAbort(): void {
    if (context.signal.aborted) {
      throw createMavioError("CANCELLED", "Native probing was cancelled.", {
        stage: "preparing",
        jobId: context.jobId,
        cause: context.signal.reason,
      });
    }
  }

  checkAbort();

  if (
    typeof inputPath !== "string" ||
    inputPath.includes("\0") ||
    !paths.isAbsolute(inputPath) ||
    (configuration.platform === "win32" && paths.parse(inputPath).root.length <= 1)
  ) {
    throw createMavioError("INVALID_INPUT", "Native probing requires an absolute file path.", {
      stage: "preparing",
      jobId: context.jobId,
      details: { reason: "INVALID_PROBE_PATH" },
    });
  }

  let file: { isFile(): boolean };

  try {
    file = await inspect(inputPath);
  } catch (cause) {
    checkAbort();

    throw createMavioError("INVALID_INPUT", "Could not inspect the input file.", {
      stage: "preparing",
      jobId: context.jobId,
      details: { reason: "INPUT_STAT_FAILED" },
      cause,
    });
  }

  checkAbort();

  if (!file.isFile()) {
    throw createMavioError("INVALID_INPUT", "The input must be a regular file.", {
      stage: "preparing",
      jobId: context.jobId,
      details: { reason: "INPUT_NOT_FILE" },
    });
  }

  let output;

  try {
    output = await run({
      executable: tools.ffprobe.path,
      args: [
        "-hide_banner",
        "-v",
        "error",
        ...NATIVE_PROBE_INPUT_ARGUMENTS,
        "-of",
        "json",
        "-show_entries",
        entries,
        "-i",
        inputPath,
      ],
      cwd: configuration.cwd,
      signal: context.signal,
      maxOutputBytes: 1_048_576,
    });
  } catch (cause) {
    const reason = cause instanceof NativeProcessError ? cause.reason : "PROCESS_FAILED";

    throw createMavioError(
      reason === "CANCELLED" ? "CANCELLED" : "EXECUTION_FAILED",
      reason === "CANCELLED"
        ? "Native probing was cancelled."
        : "FFprobe could not complete the metadata probe.",
      {
        stage: "preparing",
        jobId: context.jobId,
        details: { reason, tool: "ffprobe" },
        cause,
      },
    );
  }

  checkAbort();

  return parseNativeProbeDetails(output.stdout, context.jobId);
}

export async function probeNativeFile(
  configuration: NativeConfiguration,
  tools: PreparedNativeTools,
  inputPath: string,
  context: Pick<EngineContext, "jobId" | "signal">,
  dependencies: Dependencies = {},
): Promise<MediaMetadata> {
  const result = await probeNativeFileDetails(
    configuration,
    tools,
    inputPath,
    context,
    dependencies,
  );

  return result.metadata;
}
