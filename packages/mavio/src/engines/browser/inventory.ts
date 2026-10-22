import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type { EngineContext } from "../../contracts.js";
import { createMavioError, getErrorCode } from "../../core/errors.js";
import { parseNativeCodecList } from "../shared/codec-list.js";
import { parseNativeFilterList, parseNativeFormatList } from "../shared/feature-lists.js";
import { runBrowserWorkerCall } from "./worker-call.js";

export interface BrowserInventory {
  readonly encoders: readonly string[];
  readonly decoders: readonly string[];
  readonly muxers: readonly string[];
  readonly demuxers: readonly string[];
  readonly filters: readonly string[];
}

type ListKind = keyof BrowserInventory;

type InventoryWorker = Pick<FFmpeg, "loaded" | "terminate" | "exec" | "on" | "off">;

export async function discoverBrowserInventory(
  worker: InventoryWorker,
  context: EngineContext,
): Promise<BrowserInventory> {
  async function query(kind: ListKind): Promise<readonly string[]> {
    const lines: string[] = [];
    const encoder = new TextEncoder();
    let outputBytes = 0;
    let overflowFailure: Error | undefined;
    let rejectOverflow: (reason: unknown) => void = () => {};

    const overflow = new Promise<never>((_, reject) => {
      rejectOverflow = reject;
    });

    function onLog(event: { type: string; message: string }): void {
      // Capability tables go to stdout. Diagnostics are not table rows.
      if (event.type !== "stdout" || overflowFailure !== undefined) return;

      outputBytes += encoder.encode(event.message).byteLength + 1;

      if (outputBytes > 1_048_576) {
        overflowFailure = createMavioError(
          "ENGINE_INIT_FAILED",
          "Browser capability output exceeded its limit.",
          {
            stage: "preparing",
            jobId: context.jobId,
            details: {
              reason: "CAPABILITY_OUTPUT_LIMIT",
              list: kind,
            },
          },
        );

        rejectOverflow(overflowFailure);
        return;
      }

      lines.push(event.message);
    }

    worker.on("log", onLog);

    try {
      const exitCode = await Promise.race([
        runBrowserWorkerCall(worker, context, () => worker.exec(["-hide_banner", `-${kind}`])),
        overflow,
      ]);

      if (overflowFailure !== undefined) throw overflowFailure;

      if (exitCode !== 0) {
        throw createMavioError("ENGINE_INIT_FAILED", `Browser FFmpeg ${kind} query failed.`, {
          stage: "preparing",
          jobId: context.jobId,
          details: {
            reason: "CAPABILITY_QUERY_FAILED",
            list: kind,
          },
        });
      }

      const text = lines.join("\n");

      switch (kind) {
        case "encoders":
        case "decoders":
          return parseNativeCodecList(kind, text, context.jobId);

        case "muxers":
        case "demuxers":
          return parseNativeFormatList(kind, text, context.jobId);

        case "filters":
          return parseNativeFilterList(text, context.jobId);
      }
    } finally {
      worker.off("log", onLog);
    }
  }

  try {
    const encoders = await query("encoders");
    const decoders = await query("decoders");
    const muxers = await query("muxers");
    const demuxers = await query("demuxers");
    const filters = await query("filters");

    return Object.freeze({
      encoders,
      decoders,
      muxers,
      demuxers,
      filters,
    });
  } catch (cause) {
    const cleanupIssues: string[] = [];

    if (worker.loaded) {
      try {
        worker.terminate();
      } catch {
        cleanupIssues.push("Browser worker termination failed.");
      }
    }

    throw createMavioError(
      context.signal.aborted ? "CANCELLED" : "ENGINE_INIT_FAILED",
      context.signal.aborted
        ? "Browser capability discovery was cancelled."
        : "Browser capability discovery failed.",
      {
        stage: "preparing",
        jobId: context.jobId,
        cause,
        details:
          getErrorCode(cause) === undefined
            ? undefined
            : (
                cause as Error & {
                  details?: Readonly<Record<string, string | number | boolean>>;
                }
              ).details,
        cleanupIssues: cleanupIssues.length === 0 ? undefined : cleanupIssues,
      },
    );
  }
}
