import type {
  ExecutionOptions,
  ExportOptions,
  MediaInput,
  MediaMetadata,
  MediaResult,
  OutputTarget,
  Pipeline,
  ProcessingPlan,
  ThumbnailOptions,
  Transformation,
} from "../contracts.js";
import { appendTransformation, EMPTY_TRANSFORMATIONS } from "./composition.js";
import { captureInput } from "./input.js";
import { captureExport, captureThumbnail, validateMetadata } from "./terminals.js";

/**
 * Implemented by the client scheduler later.
 * Each execute/probe call must create a separate job.
 */
export interface PipelineExecutor {
  assertActive(): void;

  /**
   * Check disposal, then execution options and pre-aborted signals.
   * Must not initialize an engine or admit a job.
   */
  beforeSubmit(execution?: ExecutionOptions): void;

  execute<T extends OutputTarget>(
    plan: ProcessingPlan,
    execution?: ExecutionOptions,
  ): Promise<MediaResult<T>>;

  probe(input: MediaInput, execution?: ExecutionOptions): Promise<MediaMetadata>;
}

export function createPipeline(value: unknown, executor: PipelineExecutor): Pipeline {
  executor.assertActive();

  const input = captureInput(value);

  function build(transformations: readonly Transformation[]): Pipeline {
    function append(type: Transformation["type"], options?: unknown): Pipeline {
      executor.assertActive();
      return build(appendTransformation(transformations, type, options));
    }

    const pipeline: Pipeline = {
      trim: (options) => append("trim", options),
      resize: (options) => append("resize", options),
      convert: (options) => append("convert", options),
      compress: (options) => append("compress", options),
      extractAudio: (options) => append("extractAudio", options),

      async export<T extends OutputTarget>(
        options: ExportOptions<T>,
        execution?: ExecutionOptions,
      ): Promise<MediaResult<T>> {
        executor.beforeSubmit(execution);
        const terminal = captureExport(transformations, options);

        const plan: ProcessingPlan = Object.freeze({
          input,
          transformations,
          ...terminal,
        });

        return executor.execute<T>(plan, execution);
      },

      async thumbnail<T extends OutputTarget>(
        options: ThumbnailOptions<T>,
        execution?: ExecutionOptions,
      ): Promise<MediaResult<T>> {
        executor.beforeSubmit(execution);
        const terminal = captureThumbnail(transformations, options);

        const plan: ProcessingPlan = Object.freeze({
          input,
          transformations,
          ...terminal,
        });

        return executor.execute<T>(plan, execution);
      },

      async metadata(execution?: ExecutionOptions): Promise<MediaMetadata> {
        executor.beforeSubmit(execution);
        validateMetadata(transformations);
        return executor.probe(input, execution);
      },
    };

    return Object.freeze(pipeline);
  }

  return build(EMPTY_TRANSFORMATIONS);
}
