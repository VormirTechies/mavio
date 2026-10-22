import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type { EngineContext, MavioError } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";

/**
 * Runs one operation against an initialized worker.
 *
 * Calls must be serialized. After cancellation, the caller must discard
 * this worker and initialize a fresh one before accepting more work.
 *
 * Pass one worker call, not a callback containing multiple asynchronous
 * operations: each subsequent operation needs its own cancellation check.
 */
export async function runBrowserWorkerCall<T>(
  worker: Pick<FFmpeg, "loaded" | "terminate">,
  context: EngineContext,
  operation: () => Promise<T>,
): Promise<T> {
  function cancelled(
    cause: unknown = context.signal.reason,
    cleanupIssues?: readonly string[],
  ): MavioError {
    return createMavioError("CANCELLED", "Browser worker operation was cancelled.", {
      stage: "preparing",
      jobId: context.jobId,
      cause,
      cleanupIssues,
    });
  }

  // A request cancelled before admission must not disturb the worker.
  if (context.signal.aborted) throw cancelled();

  if (!worker.loaded) {
    throw createMavioError("ENGINE_UNAVAILABLE", "Browser worker is not initialized.", {
      stage: "preparing",
      jobId: context.jobId,
    });
  }

  let cancellation: MavioError | undefined;
  let rejectAbort: (reason: unknown) => void = () => {};

  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });

  function onAbort(): void {
    if (cancellation !== undefined) return;

    // Record cancellation before termination rejects pending wrapper calls.
    cancellation = cancelled();

    try {
      worker.terminate();
    } catch (cause) {
      cancellation = cancelled(
        new AggregateError(
          [context.signal.reason, cause],
          "Cancellation encountered a worker termination failure.",
        ),
        ["Browser worker termination failed."],
      );
    }

    rejectAbort(cancellation);
  }

  function checkAbort(): void {
    if (context.signal.aborted) onAbort();
    if (cancellation !== undefined) throw cancellation;
  }

  context.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        checkAbort();
        return operation();
      }),
      aborted,
    ]);

    checkAbort();
    return result;
  } catch (cause) {
    // Cancellation takes precedence over a wrapper termination rejection.
    throw cancellation ?? cause;
  } finally {
    context.signal.removeEventListener("abort", onAbort);
  }
}
