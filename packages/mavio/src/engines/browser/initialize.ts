import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type { EngineContext } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import type { BrowserConfiguration } from "./config.js";

type WrapperLoader = () => Promise<() => FFmpeg>;

async function loadWrapper(): Promise<() => FFmpeg> {
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  return () => new FFmpeg();
}

/**
 * Performs one initialization attempt.
 *
 * The engine session supplies the deadline through context.signal.
 * On success, the caller owns the worker and must terminate it on disposal.
 * On failure, this function terminates the worker before rejecting.
 */
export async function initializeBrowserWorker(
  configuration: BrowserConfiguration,
  context: EngineContext,
  loader: WrapperLoader = loadWrapper,
): Promise<FFmpeg> {
  function cancelled() {
    return createMavioError("CANCELLED", "Browser engine initialization was cancelled.", {
      stage: "preparing",
      jobId: context.jobId,
      cause: context.signal.reason,
    });
  }

  // Capture values before asynchronous loading.
  const assets = { ...configuration };

  if (context.signal.aborted) throw cancelled();

  let worker: FFmpeg | undefined;
  let rejectAbort: (reason: unknown) => void = () => {};

  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });

  function onAbort(): void {
    rejectAbort(cancelled());
  }

  function checkAborted(): void {
    if (context.signal.aborted) throw cancelled();
  }

  context.signal.addEventListener("abort", onAbort, { once: true });

  try {
    checkAborted();

    // Defer invocation so synchronous loader failures are also observed.
    const createWorker = await Promise.race([
      Promise.resolve().then(() => {
        checkAborted();
        return loader();
      }),
      aborted,
    ]);

    checkAborted();

    worker = createWorker();

    checkAborted();

    // Do not rely on the wrapper's signal handling to terminate its worker.
    await Promise.race([
      Promise.resolve().then(() => {
        checkAborted();
        return worker!.load(assets);
      }),
      aborted,
    ]);

    checkAborted();

    if (!worker.loaded) {
      throw createMavioError(
        "ENGINE_INIT_FAILED",
        "Browser worker completed loading without becoming ready.",
        {
          stage: "preparing",
          jobId: context.jobId,
          details: { reason: "BROWSER_WORKER_NOT_READY" },
        },
      );
    }

    return worker;
  } catch (cause) {
    let cleanupIssues: string[] | undefined;

    if (worker !== undefined) {
      try {
        worker.terminate();
      } catch {
        cleanupIssues = ["Browser worker termination failed."];
      }
    }

    throw createMavioError(
      context.signal.aborted ? "CANCELLED" : "ENGINE_INIT_FAILED",
      context.signal.aborted
        ? "Browser engine initialization was cancelled."
        : "Browser engine initialization failed. Verify generated same-origin JS/WASM assets, wrapper worker dependencies, HTTP responses, deployment headers, CSP, and the initialization deadline.",
      {
        stage: "preparing",
        jobId: context.jobId,
        cause,
        cleanupIssues,
      },
    );
  } finally {
    context.signal.removeEventListener("abort", onAbort);
  }
}
