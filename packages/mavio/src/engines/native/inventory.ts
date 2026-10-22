import type { EngineContext } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import { parseNativeCodecList } from "../shared/codec-list.js";
import type { NativeConfiguration } from "./config.js";
import { parseNativeFilterList, parseNativeFormatList } from "../shared/feature-lists.js";
import type { PreparedNativeTools } from "./prepare.js";
import { NativeProcessError, runNativeProcess } from "./process.js";

export interface NativeInventory {
  readonly encoders: readonly string[];
  readonly decoders: readonly string[];
  readonly muxers: readonly string[];
  readonly demuxers: readonly string[];
  readonly filters: readonly string[];
}

type ListKind = keyof NativeInventory;

export async function discoverNativeInventory(
  configuration: NativeConfiguration,
  tools: PreparedNativeTools,
  context: Pick<EngineContext, "jobId" | "signal">,
  run: typeof runNativeProcess = runNativeProcess,
): Promise<NativeInventory> {
  function checkAbort(): void {
    if (context.signal.aborted) {
      throw createMavioError("CANCELLED", "Native capability discovery was cancelled.", {
        stage: "preparing",
        jobId: context.jobId,
        cause: context.signal.reason,
      });
    }
  }

  async function query(kind: ListKind): Promise<readonly string[]> {
    checkAbort();

    let output;

    try {
      output = await run({
        executable: tools.ffmpeg.path,
        args: ["-hide_banner", `-${kind}`],
        cwd: configuration.cwd,
        signal: context.signal,
        maxOutputBytes: 1_048_576,
      });
    } catch (cause) {
      const reason = cause instanceof NativeProcessError ? cause.reason : "PROCESS_FAILED";

      // Preserve the runner's selected failure even if an abort arrives later.
      throw createMavioError(
        reason === "CANCELLED" ? "CANCELLED" : "ENGINE_INIT_FAILED",
        reason === "CANCELLED"
          ? "Native capability discovery was cancelled."
          : `FFmpeg ${kind} query failed.`,
        {
          stage: "preparing",
          jobId: context.jobId,
          details: {
            reason,
            tool: "ffmpeg",
            list: kind,
          },
          cause,
        },
      );
    }

    checkAbort();

    // These commands print their tables to stdout.
    // Keep stderr diagnostics separate from capability data.
    switch (kind) {
      case "encoders":
      case "decoders":
        return parseNativeCodecList(kind, output.stdout, context.jobId);
      case "muxers":
      case "demuxers":
        return parseNativeFormatList(kind, output.stdout, context.jobId);
      case "filters":
        return parseNativeFilterList(output.stdout, context.jobId);
    }
  }

  const encoders = await query("encoders");
  const decoders = await query("decoders");
  const muxers = await query("muxers");
  const demuxers = await query("demuxers");
  const filters = await query("filters");

  checkAbort();

  return Object.freeze({
    encoders,
    decoders,
    muxers,
    demuxers,
    filters,
  });
}
