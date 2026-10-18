import { lstat } from "node:fs/promises";
import type { EngineContext } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import type { NativeConfiguration } from "./config.js";
import { buildNativeAudioCommand } from "./audio-command.js";
import type { PreparedNativeTools } from "./prepare.js";
import { NativeProcessError, runNativeProcess } from "./process.js";

interface Dependencies {
  inspect?: (path: string) => Promise<{
    isFile(): boolean;
    size: number;
  }>;
  run?: typeof runNativeProcess;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Writes only to a new intermediate path in an adapter-owned directory.
 * The caller owns cleanup and subsequent media validation/publication.
 */
export async function executeNativeAudioFile(
  configuration: NativeConfiguration,
  tools: PreparedNativeTools,
  options: Parameters<typeof buildNativeAudioCommand>[0],
  context: Pick<EngineContext, "jobId" | "signal">,
  dependencies: Dependencies = {},
): Promise<void> {
  const inspect = dependencies.inspect ?? lstat;
  const run = dependencies.run ?? runNativeProcess;

  function checkAbort(): void {
    if (context.signal.aborted) {
      throw createMavioError("CANCELLED", "Native encoding was cancelled.", {
        stage: "running",
        jobId: context.jobId,
        cause: context.signal.reason,
      });
    }
  }

  checkAbort();
  const args = buildNativeAudioCommand(options);

  let occupied = false;

  try {
    await inspect(options.outputPath);
    occupied = true;
  } catch (cause) {
    if (!isMissing(cause)) {
      throw createMavioError("IO_ERROR", "Could not inspect the intermediate path.", {
        stage: "preparing",
        jobId: context.jobId,
        details: { reason: "OUTPUT_INSPECTION_FAILED" },
        cause,
      });
    }
  }

  checkAbort();

  if (occupied) {
    throw createMavioError("OUTPUT_EXISTS", "The intermediate path already exists.", {
      stage: "preparing",
      jobId: context.jobId,
      details: { reason: "INTERMEDIATE_OUTPUT_EXISTS" },
    });
  }

  let result;

  try {
    result = await run({
      executable: tools.ffmpeg.path,
      args,
      cwd: configuration.cwd,
      signal: context.signal,
      maxOutputBytes: 1_048_576,
    });
  } catch (cause) {
    const reason = cause instanceof NativeProcessError ? cause.reason : "PROCESS_FAILED";

    throw createMavioError(
      reason === "CANCELLED" ? "CANCELLED" : "EXECUTION_FAILED",
      "Native audio encoding did not complete.",
      {
        stage: "running",
        jobId: context.jobId,
        details: { reason, tool: "ffmpeg" },
        cause,
      },
    );
  }

  // This command uses "-v error". A zero exit with an error diagnostic
  // must not be treated as successful encoding.
  if (result.stderr.trim() !== "") {
    throw createMavioError(
      "EXECUTION_FAILED",
      "FFmpeg reported an error despite returning a successful exit status.",
      {
        stage: "running",
        jobId: context.jobId,
        details: { reason: "ENCODER_ERROR_DIAGNOSTIC", tool: "ffmpeg" },
      },
    );
  }

  checkAbort();

  let file;

  try {
    file = await inspect(options.outputPath);
  } catch (cause) {
    throw createMavioError("IO_ERROR", "Could not inspect the encoded output.", {
      stage: "finalizing",
      jobId: context.jobId,
      details: { reason: "ENCODED_OUTPUT_INSPECTION_FAILED" },
      cause,
    });
  }

  checkAbort();

  if (!file.isFile() || !Number.isSafeInteger(file.size) || file.size <= 0) {
    throw createMavioError(
      "EXECUTION_FAILED",
      "FFmpeg did not produce a non-empty regular output file.",
      {
        stage: "finalizing",
        jobId: context.jobId,
        details: { reason: "INVALID_ENCODED_OUTPUT" },
      },
    );
  }
}
