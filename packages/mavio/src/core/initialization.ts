import type { EngineAdapter, EngineCapabilities, EngineContext, MavioError } from "../contracts.js";
import { createMavioError } from "./errors.js";

export function validateInitTimeout(value: number): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw createMavioError("INVALID_OPTIONS", "initTimeoutMs must be a positive finite integer.", {
      details: { reason: "INVALID_INIT_TIMEOUT" },
    });
  }
}

export async function initializeEngine(
  engine: EngineAdapter,
  context: EngineContext,
  timeoutMs: number,
): Promise<EngineCapabilities> {
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let failure: MavioError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function stop(reason: "TIMEOUT" | "CANCELLED"): void {
    if (failure !== undefined) return;

    failure = createMavioError(
      reason === "TIMEOUT" ? "ENGINE_INIT_FAILED" : "CANCELLED",
      reason === "TIMEOUT"
        ? "Engine initialization exceeded its deadline."
        : "Engine initialization was cancelled.",
      {
        stage: "preparing",
        jobId: context.jobId,
        engineId: engine.id,
        details: { reason },
      },
    );

    // Record the primary reason before invoking adapter abort listeners.
    controller.abort(failure);
  }

  function checkDeadline(): void {
    if (performance.now() >= deadline) stop("TIMEOUT");
  }

  function onAbort(): void {
    checkDeadline();
    stop("CANCELLED");
  }

  function armTimer(): void {
    const remaining = deadline - performance.now();

    if (remaining <= 0) {
      stop("TIMEOUT");
      return;
    }

    // Long configured deadlines must not overflow platform timers.
    timer = setTimeout(armTimer, Math.min(remaining, 2_147_483_647));
  }

  function checkStopped(): void {
    checkDeadline();
    if (failure !== undefined) throw failure;
  }

  try {
    context.signal.addEventListener("abort", onAbort, { once: true });

    if (context.signal.aborted) onAbort();
    checkStopped();
    armTimer();

    await engine.initialize({
      ...context,
      signal: controller.signal,
    });

    checkStopped();

    const capabilities = await engine.capabilities();

    checkStopped();
    return capabilities;
  } catch (cause) {
    // Preserve timeout/cancellation instead of an adapter termination error.
    throw failure ?? cause;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    context.signal.removeEventListener("abort", onAbort);
  }
}
