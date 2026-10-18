import { stat } from "node:fs/promises";
import type { EngineContext } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import type { NativeConfiguration } from "./config.js";

type InspectFile = (path: string) => Promise<{ isFile(): boolean }>;

export interface NativeTools {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
}

export async function discoverNativeTools(
  configuration: NativeConfiguration,
  context: Pick<EngineContext, "jobId" | "signal">,
  inspect: InspectFile = stat,
): Promise<NativeTools> {
  function checkAbort(): void {
    if (context.signal.aborted) {
      throw createMavioError("CANCELLED", "Native discovery was cancelled.", {
        stage: "preparing",
        jobId: context.jobId,
        cause: context.signal.reason,
      });
    }
  }

  async function find(tool: "ffmpeg" | "ffprobe", candidates: readonly string[]): Promise<string> {
    checkAbort();

    for (const candidate of candidates) {
      checkAbort();

      let entry: { isFile(): boolean };

      try {
        entry = await inspect(candidate);
      } catch (cause) {
        checkAbort();

        const code =
          cause !== null && typeof cause === "object" && "code" in cause ? cause.code : undefined;

        if (code === "ENOENT" || code === "ENOTDIR") continue;

        throw createMavioError(
          "ENGINE_INIT_FAILED",
          `Could not inspect a ${tool} executable candidate.`,
          {
            stage: "preparing",
            jobId: context.jobId,
            details: { reason: "DISCOVERY_FAILED", tool },
            cause,
          },
        );
      }

      checkAbort();

      if (entry.isFile()) return candidate;
    }

    checkAbort();

    throw createMavioError(
      "ENGINE_UNAVAILABLE",
      `${tool} was not found. Install it and configure an absolute binary path or PATH.`,
      {
        stage: "preparing",
        jobId: context.jobId,
        details: { reason: "BINARY_NOT_FOUND", tool },
      },
    );
  }

  const ffmpegPath = await find("ffmpeg", configuration.ffmpegCandidates);
  const ffprobePath = await find("ffprobe", configuration.ffprobeCandidates);

  checkAbort();
  return Object.freeze({ ffmpegPath, ffprobePath });
}
