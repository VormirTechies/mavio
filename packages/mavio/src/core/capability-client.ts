import type {
  EngineAdapter,
  EngineCapabilities,
  ExecutionEngineContext,
  ExecutionOptions,
  MediaInput,
  MediaMetadata,
  MavioClient,
  MavioError,
  MavioOptions,
  MediaResult,
  OperationName,
  OutputTarget,
  ProcessingPlan,
} from "../contracts.js";
import { EngineSession } from "./engine-session.js";
import { createMavioError, getErrorCode, preserveFailure } from "./errors.js";
import { executeWithEngine } from "./execution.js";
import { createPipeline, type PipelineExecutor } from "./pipeline.js";
import { allocateJobId, createProgress } from "./progress.js";
import { SerialQueue } from "./queue.js";
import { resolveMediaInput, resolveProcessingPlan, type RuntimeContext } from "./runtime.js";
import { captureMetadata } from "./adapter-response.js";

type ClientOptions = Pick<MavioOptions, "maxQueuedJobs" | "initTimeoutMs">;

export function createCapabilityClient(
  engine: EngineAdapter,
  options: ClientOptions = {},
  runtime: RuntimeContext = { runtime: engine.runtime },
): MavioClient {
  const environment = Object.freeze({ ...runtime });

  if (environment.runtime !== engine.runtime) {
    throw createMavioError(
      "UNSUPPORTED_RUNTIME",
      "Engine runtime does not match the client runtime.",
    );
  }
  const queue = new SerialQueue(options.maxQueuedJobs);
  const session = new EngineSession(engine, options.initTimeoutMs);
  const engineId = engine.id;
  let disposed = false;
  let disposalPromise: Promise<void> | undefined;

  function assertActive(): void {
    if (disposed) {
      throw createMavioError("DISPOSED", "Client is disposed.");
    }
  }

  function beforeSubmit(execution?: ExecutionOptions): void {
    assertActive();

    if (
      execution !== undefined &&
      (execution === null || typeof execution !== "object" || Array.isArray(execution))
    ) {
      throw createMavioError("INVALID_OPTIONS", "Execution options must be an object.");
    }

    const { signal, onProgress } = execution ?? {};

    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw createMavioError("INVALID_OPTIONS", "Invalid abort signal.");
    }

    if (signal?.aborted) {
      throw createMavioError("CANCELLED", "Request was already cancelled.");
    }

    if (onProgress !== undefined && typeof onProgress !== "function") {
      throw createMavioError("INVALID_OPTIONS", "onProgress must be a function.");
    }
  }

  async function request<T>(
    work: (context: ExecutionEngineContext, inventory: EngineCapabilities) => Promise<T>,
    execution?: ExecutionOptions,
    operation?: OperationName,
  ): Promise<T> {
    beforeSubmit(execution);
    const { signal, onProgress } = execution ?? {};

    let jobId: string | undefined;
    let progress: ReturnType<typeof createProgress> | undefined;

    try {
      const result = await queue.submit(
        async (jobSignal, beginCommit) => {
          if (jobId === undefined || progress === undefined) {
            throw new Error("Missing job admission state.");
          }

          const tracker = progress;
          tracker.report("preparing");

          const inventory = await session.ready({
            jobId,
            signal: jobSignal,
            reportProgress: () => tracker.report("preparing"),
          });

          if (jobSignal.aborted) {
            throw createMavioError("CANCELLED", "Request was cancelled.");
          }

          let committed = false;

          const commit = (): boolean => {
            if (committed) return false;
            committed = beginCommit();
            return committed;
          };

          const result = await work(
            {
              jobId,
              signal: jobSignal,
              reportProgress: (event) => tracker.report(event.stage),
              beginCommit: commit,
            },
            inventory,
          );

          tracker.report("finalizing");

          // Metadata/capabilities commit here. Engines commit during publication.
          if (!committed && !commit()) {
            throw createMavioError("CANCELLED", "Request was cancelled.");
          }

          return result;
        },
        signal,
        () => {
          jobId = allocateJobId();
          progress = createProgress({ jobId, engineId, onProgress });
          progress.report("queued");
        },
      );

      progress?.report("completed");
      return result;
    } catch (cause) {
      if (progress === undefined) throw cause;

      const outer = cause instanceof Error ? (cause as Partial<MavioError>) : undefined;
      const inner =
        outer?.cause instanceof Error ? (outer.cause as Partial<MavioError>) : undefined;

      const primary =
        outer?.code === "CANCELLED" &&
        inner?.code === "ENGINE_INIT_FAILED" &&
        inner.details?.reason === "TIMEOUT"
          ? inner
          : outer;

      const code = getErrorCode(primary) ?? "EXECUTION_FAILED";

      const error = createMavioError(code, primary?.message ?? "Request failed.", {
        stage: progress.stage ?? "queued",
        jobId,
        engineId,
        operation: primary?.operation ?? operation,
        details: primary?.details,
        cleanupIssues: primary?.cleanupIssues ?? inner?.cleanupIssues,
        cause,
      });

      progress.report(code === "CANCELLED" ? "cancelled" : "failed");
      throw error;
    }
  }

  function capabilities(execution?: ExecutionOptions): Promise<EngineCapabilities> {
    return request(async (context, inventory) => {
      context.reportProgress({ stage: "running" });
      return inventory;
    }, execution);
  }

  async function probe(input: MediaInput, execution?: ExecutionOptions): Promise<MediaMetadata> {
    beforeSubmit(execution);

    const resolvedInput = resolveMediaInput(input, environment);

    return request(
      async (context, inventory) => {
        if (
          !inventory.operations.includes("metadata") ||
          !inventory.inputKinds.includes(input.kind)
        ) {
          throw createMavioError(
            "UNSUPPORTED_CAPABILITY",
            "This engine cannot probe the supplied input kind.",
            { operation: "metadata" },
          );
        }

        let probing = true;

        try {
          context.reportProgress({ stage: "running" });

          if (context.signal.aborted) {
            throw createMavioError("CANCELLED", "Probe was cancelled.");
          }

          const metadata = await engine.probe(resolvedInput, {
            jobId: context.jobId,
            signal: context.signal,
            reportProgress: () => {
              // Probe callbacks cannot finalize or complete the job.
              if (probing) {
                context.reportProgress({ stage: "running" });
              }
            },
          });

          if (context.signal.aborted) {
            throw createMavioError("CANCELLED", "Probe was cancelled.");
          }

          // Returned metadata must not retain mutable engine-owned objects.
          return captureMetadata(metadata);
        } catch (cause) {
          probing = false;

          const code = context.signal.aborted
            ? "CANCELLED"
            : (getErrorCode(cause) ?? "EXECUTION_FAILED");

          const primary = cause instanceof Error ? (cause as Partial<MavioError>) : undefined;
          const cleanupIssues = [...(primary?.cleanupIssues ?? [])];

          try {
            await session.reset();
          } catch {
            cleanupIssues.push("Engine cleanup after metadata probing failed.");
          }

          throw preserveFailure(
            createMavioError(code, primary?.message ?? "Metadata probe failed.", {
              operation: "metadata",
              cause,
              details: primary?.details,
              cleanupIssues: cleanupIssues.length === 0 ? undefined : cleanupIssues,
            }),
          );
        } finally {
          probing = false;
        }
      },
      execution,
      "metadata",
    );
  }

  const executor: PipelineExecutor = {
    assertActive,
    beforeSubmit,
    probe,

    async execute<T extends OutputTarget>(
      plan: ProcessingPlan,
      execution?: ExecutionOptions,
    ): Promise<MediaResult<T>> {
      beforeSubmit(execution);

      const resolvedPlan = resolveProcessingPlan(plan, environment);

      const operation =
        plan.terminal.type === "thumbnail"
          ? "thumbnail"
          : plan.transformations.some((item) => item.type === "convert")
            ? "convert"
            : "compress";

      return request(
        (context, inventory) =>
          executeWithEngine<T>(engine, session, resolvedPlan, context, inventory),
        execution,
        operation,
      );
    },
  };

  function dispose(): Promise<void> {
    if (disposalPromise !== undefined) return disposalPromise;

    disposed = true;

    disposalPromise = Promise.resolve()
      .then(() => drained)
      .then(() => session.dispose());

    const drained = queue.dispose();
    return disposalPromise;
  }

  return Object.freeze({
    from: (input: MediaInput) => createPipeline(input, executor),
    capabilities,
    dispose,
  });
}
