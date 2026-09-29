import type { EngineAdapter, EngineCapabilities, EngineContext } from "../contracts.js";
import { createMavioError } from "./errors.js";
import { initializeEngine, validateInitTimeout } from "./initialization.js";

/**
 * Owned by one client.
 * ready() must run inside the client's serial queue.
 * dispose() must run after that queue has drained.
 */
export class EngineSession {
  private capabilities: EngineCapabilities | undefined;
  private touched = false;
  private unsafe = false;
  private disposed = false;
  private disposalPromise: Promise<void> | undefined;

  constructor(
    private readonly engine: EngineAdapter,
    private readonly initTimeoutMs = 30_000,
  ) {
    validateInitTimeout(initTimeoutMs);
  }

  async ready(context: EngineContext): Promise<EngineCapabilities> {
    if (this.disposed) {
      throw createMavioError("DISPOSED", "Engine session is disposed.");
    }

    if (context.signal.aborted) {
      throw createMavioError("CANCELLED", "Initialization was cancelled.", {
        stage: "preparing",
        jobId: context.jobId,
        engineId: this.engine.id,
      });
    }

    if (this.unsafe) {
      throw createMavioError(
        "ENGINE_UNAVAILABLE",
        "Engine cleanup failed; this session cannot be reused.",
        {
          stage: "preparing",
          jobId: context.jobId,
          engineId: this.engine.id,
          details: { reason: "UNSAFE_ENGINE_STATE" },
        },
      );
    }

    if (this.capabilities !== undefined) {
      return structuredClone(this.capabilities);
    }

    this.touched = true;

    try {
      const capabilities = await initializeEngine(this.engine, context, this.initTimeoutMs);

      this.capabilities = structuredClone(capabilities);
      return structuredClone(this.capabilities);
    } catch (cause) {
      const cancelled = cause instanceof Error && "code" in cause && cause.code === "CANCELLED";

      const unavailable =
        cause instanceof Error && "code" in cause && cause.code === "ENGINE_UNAVAILABLE";

      const timedOut =
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "ENGINE_INIT_FAILED" &&
        "details" in cause &&
        cause.details !== null &&
        typeof cause.details === "object" &&
        "reason" in cause.details &&
        cause.details.reason === "TIMEOUT";
      let cleanupIssues: string[] | undefined;

      try {
        await this.engine.dispose();
        this.touched = false;
      } catch {
        this.unsafe = true;
        cleanupIssues = ["Engine cleanup after initialization failure failed."];
      }

      throw createMavioError(
        cancelled ? "CANCELLED" : unavailable ? "ENGINE_UNAVAILABLE" : "ENGINE_INIT_FAILED",
        cancelled ? "Engine initialization was cancelled." : "Engine initialization failed.",
        {
          stage: "preparing",
          jobId: context.jobId,
          engineId: this.engine.id,
          cause,
          cleanupIssues,
          details: timedOut ? { reason: "TIMEOUT" } : undefined,
        },
      );
    }
  }

  /**
   * Called inside the serial queue after media work fails.
   * Successful cleanup allows lazy reinitialization on the next job.
   */
  async reset(): Promise<void> {
    this.capabilities = undefined;

    if (!this.touched) return;

    try {
      await this.engine.dispose();
      this.touched = false;
    } catch (cause) {
      this.unsafe = true;

      throw createMavioError("CLEANUP_FAILED", "Engine reset failed.", {
        stage: "finalizing",
        engineId: this.engine.id,
        cause,
      });
    }
  }

  dispose(): Promise<void> {
    if (this.disposalPromise !== undefined) {
      return this.disposalPromise;
    }

    this.disposed = true;
    this.capabilities = undefined;

    // Defer engine callbacks until the shared promise has been assigned.
    this.disposalPromise = Promise.resolve().then(async () => {
      if (!this.touched) return;

      try {
        await this.engine.dispose();
        this.touched = false;
      } catch (cause) {
        throw createMavioError("CLEANUP_FAILED", "Engine disposal failed.", {
          stage: "finalizing",
          engineId: this.engine.id,
          cause,
        });
      }
    });

    return this.disposalPromise;
  }
}
