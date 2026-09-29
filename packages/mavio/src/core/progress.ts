import type { JobStage, ProgressEvent } from "../contracts.js";

const stages = ["queued", "preparing", "running", "finalizing", "completed"] as const;

let nextJobId = 0;

export function allocateJobId(): string {
  nextJobId += 1;
  return `mavio-${nextJobId}`;
}

interface ProgressOptions {
  jobId: string;
  engineId?: string;
  onProgress?: (event: Readonly<ProgressEvent>) => void;
  now?: () => number;
}

export function createProgress(options: ProgressOptions) {
  // Capture configuration instead of retaining the mutable options object.
  const { jobId, engineId, onProgress } = options;
  const now = options.now ?? (() => performance.now());

  let current: JobStage | undefined;
  let terminal = false;
  let lastPercent: number | undefined;
  let lastDelivery = -Infinity;

  function deliver(stage: JobStage, percent?: number): void {
    current = stage;
    terminal = stage === "completed" || stage === "failed" || stage === "cancelled";

    // An observer may have advanced progress since this value was calculated.
    if (percent !== undefined && (lastPercent === undefined || percent >= lastPercent)) {
      lastPercent = percent;
    }
    lastDelivery = now();

    const event: Readonly<ProgressEvent> = Object.freeze({
      jobId,
      stage,
      ...(engineId === undefined ? {} : { engineId }),
      ...(lastPercent === undefined ? {} : { percent: lastPercent }),
    });

    try {
      // Runtime callers may return a promise despite the void signature.
      const returned: unknown = onProgress?.(event);
      void Promise.resolve(returned).catch(() => undefined);
    } catch {
      // An observer cannot fail or delay the job.
    }
  }

  function report(stage: JobStage, percent?: number): void {
    if (terminal) return;

    if (current === undefined) {
      deliver("queued");
      // The observer may have cancelled the job reentrantly.
      if (terminal) return;
    }

    if (stage === "failed" || stage === "cancelled") {
      deliver(stage);
      return;
    }

    const targetIndex = stages.indexOf(stage);
    const currentIndex = stages.indexOf(current as (typeof stages)[number]);

    if (targetIndex < currentIndex) return;

    const validPercent =
      typeof percent === "number" &&
      Number.isFinite(percent) &&
      percent >= 0 &&
      percent < 100 &&
      (lastPercent === undefined || percent >= lastPercent)
        ? percent
        : undefined;

    if (targetIndex === currentIndex) {
      if (
        validPercent === undefined ||
        validPercent === lastPercent ||
        now() - lastDelivery < 100
      ) {
        return;
      }

      deliver(stage, validPercent);
      return;
    }

    // Deliver every stage transition, even if the caller skips a stage.
    for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
      if (terminal) return;

      // A reentrant observer may already have advanced this tracker.
      const latestIndex = stages.indexOf(current as (typeof stages)[number]);
      if (index <= latestIndex) continue;

      const next = stages[index];

      deliver(next, next === "completed" ? 100 : index === targetIndex ? validPercent : undefined);
    }
  }

  return Object.freeze({
    report,
    get stage(): JobStage | undefined {
      return current;
    },
  });
}
