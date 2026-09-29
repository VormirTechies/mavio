import type {
  EngineAdapter,
  EngineCapabilities,
  ExecutionEngineContext,
  MediaOutput,
  MediaResult,
  MavioError,
  OutputFor,
  OutputTarget,
  ProcessingPlan,
} from "../contracts.js";
import type { EngineSession } from "./engine-session.js";
import { createMavioError, getErrorCode } from "./errors.js";
import { validatePlanCapabilities, validateSource } from "./preflight.js";

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
  let stage: "preparing" | "running" | "finalizing" = "preparing";

  function checkAbort(): void {
    if (context.signal.aborted) {
      throw createMavioError("CANCELLED", "Execution was cancelled.");
    }
  }

  function protocol(reason: string): never {
    throw createMavioError("EXECUTION_FAILED", "Engine returned an invalid execution result.", {
      details: { reason },
    });
  }

  try {
    checkAbort();
    validatePlanCapabilities(plan, inventory);

    touched = true;
    const source = structuredClone(
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

    const support = await engine.supports(plan, source);
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

    const result = await engine.execute(plan, {
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
        if (!live || publicationGranted || context.signal.aborted) {
          return false;
        }

        stage = "finalizing";
        context.reportProgress({ stage });

        publicationGranted = context.beginCommit();
        return publicationGranted;
      },
    });

    checkAbort();

    if (!publicationGranted) protocol("COMMIT_GATE_REQUIRED");

    if (result.output.kind !== plan.output.kind) {
      protocol("OUTPUT_KIND_MISMATCH");
    }

    let output: MediaOutput;

    switch (result.output.kind) {
      case "bytes":
        if (!(result.output.bytes instanceof Uint8Array) || result.output.bytes.byteLength === 0) {
          protocol("INVALID_OUTPUT_BYTES");
        }

        // Copy out of engine-owned storage before any later disposal.
        output = {
          kind: "bytes",
          bytes: new Uint8Array(result.output.bytes),
        };
        break;

      case "blob":
        if (!(result.output.blob instanceof Blob) || result.output.blob.size === 0) {
          protocol("INVALID_OUTPUT_BLOB");
        }

        output = { kind: "blob", blob: result.output.blob };
        break;

      case "path":
        if (plan.output.kind !== "path" || result.output.path !== plan.output.path) {
          protocol("OUTPUT_PATH_MISMATCH");
        }

        output = { kind: "path", path: result.output.path };
        break;

      default:
        return protocol("INVALID_OUTPUT_KIND");
    }

    return {
      jobId: context.jobId,
      output: output as OutputFor<T>,
      metadata: structuredClone(result.metadata),
      engine: {
        id: engine.id,
        version: inventory.engineVersion,
      },
      ...(result.warnings === undefined ? {} : { warnings: structuredClone(result.warnings) }),
    };
  } catch (cause) {
    live = false;

    const primary = cause instanceof Error ? (cause as Partial<MavioError>) : undefined;
    const cleanupIssues = [...(primary?.cleanupIssues ?? [])];

    if (touched) {
      try {
        await session.reset();
      } catch {
        cleanupIssues.push("Engine cleanup after execution failed.");
      }
    }

    throw createMavioError(
      context.signal.aborted ? "CANCELLED" : (getErrorCode(cause) ?? "EXECUTION_FAILED"),
      primary?.message ?? "Media execution failed.",
      {
        stage,
        jobId: context.jobId,
        engineId: engine.id,
        details: primary?.details,
        cleanupIssues: cleanupIssues.length === 0 ? undefined : cleanupIssues,
        cause,
      },
    );
  } finally {
    live = false;
  }
}
