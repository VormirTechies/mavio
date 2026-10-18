import type { EngineContext } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import type { NativeConfiguration } from "./config.js";
import { discoverNativeTools } from "./discovery.js";
import { NativeProcessError, runNativeProcess } from "./process.js";

interface ToolIdentity {
  readonly path: string;
  readonly version: string;
}

export interface PreparedNativeTools {
  readonly ffmpeg: ToolIdentity;
  readonly ffprobe: ToolIdentity;
}

interface Dependencies {
  discover?: typeof discoverNativeTools;
  run?: typeof runNativeProcess;
}

export async function prepareNativeTools(
  configuration: NativeConfiguration,
  context: Pick<EngineContext, "jobId" | "signal">,
  dependencies: Dependencies = {},
): Promise<PreparedNativeTools> {
  const discover = dependencies.discover ?? discoverNativeTools;
  const run = dependencies.run ?? runNativeProcess;

  function checkAbort(): void {
    if (context.signal.aborted) {
      throw createMavioError("CANCELLED", "Native preparation was cancelled.", {
        stage: "preparing",
        jobId: context.jobId,
        cause: context.signal.reason,
      });
    }
  }

  checkAbort();
  const tools = await discover(configuration, context);
  checkAbort();

  async function identify(tool: "ffmpeg" | "ffprobe", executable: string): Promise<ToolIdentity> {
    checkAbort();

    let output;

    try {
      output = await run({
        executable,
        args: ["-version"],
        cwd: configuration.cwd,
        signal: context.signal,
        maxOutputBytes: 65_536,
      });
    } catch (cause) {
      const reason = cause instanceof NativeProcessError ? cause.reason : "PROCESS_FAILED";

      throw createMavioError(
        reason === "CANCELLED" ? "CANCELLED" : "ENGINE_INIT_FAILED",
        reason === "CANCELLED"
          ? "Native preparation was cancelled."
          : `${tool} version check failed.`,
        {
          stage: "preparing",
          jobId: context.jobId,
          details: { reason, tool },
          cause,
        },
      );
    }

    checkAbort();

    const text = output.stdout.trim().length > 0 ? output.stdout : output.stderr;

    const firstLine = text.trimStart().split(/\r?\n/, 1)[0];

    // Capture only a bounded printable version token, not the full banner.
    const match = /^(ffmpeg|ffprobe) version ([!-~]{1,200})(?:[ \t]|$)/.exec(firstLine);

    if (match === null || match[1] !== tool) {
      throw createMavioError(
        "ENGINE_INIT_FAILED",
        `${tool} returned an unexpected version banner.`,
        {
          stage: "preparing",
          jobId: context.jobId,
          details: { reason: "INVALID_VERSION_BANNER", tool },
        },
      );
    }

    return Object.freeze({
      path: executable,
      version: match[2],
    });
  }

  const ffmpeg = await identify("ffmpeg", tools.ffmpegPath);
  const ffprobe = await identify("ffprobe", tools.ffprobePath);

  checkAbort();
  return Object.freeze({ ffmpeg, ffprobe });
}
