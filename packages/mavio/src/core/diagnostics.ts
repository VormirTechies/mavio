import type { DiagnosticEvent, ErrorCode, JobStage, Runtime } from "../contracts.js";
import { createMavioError } from "./errors.js";

type DiagnosticPayload =
  | {
      type: "job-progress";
      jobId: string;
      stage: JobStage;
      percent?: number;
    }
  | {
      type: "job-error";
      jobId: string;
      stage: JobStage;
      code: ErrorCode;
    };

export function createDiagnosticReporter(
  engineId: string,
  runtime: Runtime,
  observer?: (event: Readonly<DiagnosticEvent>) => void,
): (event: DiagnosticPayload) => void {
  if (observer !== undefined && typeof observer !== "function") {
    throw createMavioError("INVALID_OPTIONS", "onDiagnostic must be a function.");
  }

  return (event) => {
    if (observer === undefined) return;

    // Copy only approved fields. Never spread an error or adapter response.
    const common = {
      engineId,
      runtime,
      jobId: event.jobId,
      stage: event.stage,
    };

    const snapshot: Readonly<DiagnosticEvent> = Object.freeze(
      event.type === "job-error"
        ? { ...common, type: "job-error" as const, code: event.code }
        : {
            ...common,
            type: "job-progress" as const,
            ...(event.percent === undefined ? {} : { percent: event.percent }),
          },
    );

    // Avoid synchronous observer reentry into job admission or progress.
    queueMicrotask(() => {
      try {
        const returned: unknown = observer(snapshot);
        void Promise.resolve(returned).catch(() => undefined);
      } catch {
        // Diagnostics must not fail a job.
      }
    });
  };
}
