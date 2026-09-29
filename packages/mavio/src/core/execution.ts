import type {
  EngineAdapter,
  EngineCapabilities,
  ExecutionEngineContext,
  MediaResult,
  MavioError,
  OutputFor,
  OutputTarget,
  ProcessingPlan,
} from "../contracts.js";
import type { EngineSession } from "./engine-session.js";
import { createMavioError, getErrorCode, preserveFailure } from "./errors.js";
import { validatePlanCapabilities, validateSource } from "./preflight.js";
import {
  captureExecutionResult,
  captureMetadata,
  captureSupportResult,
} from "./adapter-response.js";

export async function executeWithEngine<T extends OutputTarget>(
  engine: EngineAdapter,
  session: EngineSession,
  plan: ProcessingPlan,
  context: ExecutionEngineContext,
  inventory: EngineCapabilities,
): Promise<MediaResult<T>> {
  let live = true;
  let touched = false;
  let publicationGranted = false;
  let commitRequested = false;
  let stage: "preparing" | "running" | "finalizing" = "preparing";

  function checkAbort(): void {
    if (context.signal.aborted) {
      throw createMavioError("CANCELLED", "Execution was cancelled.");
    }
  }

  function protocol(violation: string): never {
    throw createMavioError("EXECUTION_FAILED", "Engine returned an invalid execution result.", {
      details: {
        reason: "ENGINE_CONTRACT_VIOLATION",
        response: "execution",
        violation,
      },
    });
  }

  try {
    checkAbort();
    validatePlanCapabilities(plan, inventory);

    touched = true;
    const source = captureMetadata(
      await engine.probe(plan.input, {
        jobId: context.jobId,
        signal: context.signal,
        reportProgress: () => {
          if (live && stage === "preparing") {
            context.reportProgress({ stage: "preparing" });
          }
        },
      }),
    );

    checkAbort();
    validateSource(plan, source);

    const support = captureSupportResult(await engine.supports(plan, source));
    checkAbort();

    if (support.status !== "supported") {
      throw createMavioError(
        "UNSUPPORTED_CAPABILITY",
        "Engine could not confirm support for this processing plan.",
        {
          details: {
            reason: support.status === "unknown" ? "UNKNOWN_SUPPORT" : "UNSUPPORTED_PLAN",
          },
        },
      );
    }

    stage = "running";
    context.reportProgress({ stage });
    checkAbort();

    const rawResult = await engine.execute(plan, {
      jobId: context.jobId,
      signal: context.signal,

      reportProgress: (event) => {
        if (!live) return;

        if (event.stage === "finalizing") stage = "finalizing";
        if (event.stage === "preparing") return;

        // Engine percentages are not yet mapped to job-level percentages.
        context.reportProgress({ stage });
      },

      beginCommit: () => {
        if (!live || commitRequested || context.signal.aborted) {
          return false;
        }

        // Reserve the attempt before an observer can call back into this method.
        commitRequested = true;

        stage = "finalizing";
        context.reportProgress({ stage });

        publicationGranted = context.beginCommit();
        return publicationGranted;
      },
    });

    if (!publicationGranted) {
      checkAbort();
      protocol("COMMIT_GATE_REQUIRED");
    }

    const result = captureExecutionResult(rawResult, plan.output);

    return {
      jobId: context.jobId,
      output: result.output as OutputFor<T>,
      metadata: result.metadata,
      engine: {
        id: engine.id,
        version: inventory.engineVersion,
      },
      ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
    };
  } catch (cause) {
    live = false;

    // Choose the outcome before cleanup can trigger another abort.
    const code = context.signal.aborted ? "CANCELLED" : (getErrorCode(cause) ?? "EXECUTION_FAILED");

    const primary = cause instanceof Error ? (cause as Partial<MavioError>) : undefined;
    const cleanupIssues = [...(primary?.cleanupIssues ?? [])];

    if (touched) {
      try {
        await session.reset();
      } catch {
        cleanupIssues.push("Engine cleanup after execution failed.");
      }
    }

    throw preserveFailure(
      createMavioError(code, primary?.message ?? "Media execution failed.", {
        stage,
        jobId: context.jobId,
        engineId: engine.id,
        operation: primary?.operation,
        details: primary?.details,
        cleanupIssues: cleanupIssues.length === 0 ? undefined : cleanupIssues,
        cause,
      }),
    );
  } finally {
    live = false;
  }
}
