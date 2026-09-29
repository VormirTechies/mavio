import { createMavioError, isPreservedFailure } from "./errors.js";

interface QueueEntry {
  start(): void;
  cancel(): void;
}

export class SerialQueue {
  private active = false;
  private readonly waiting: QueueEntry[] = [];
  private readonly maxQueuedJobs: number;
  private disposed = false;
  private activeEntry: QueueEntry | undefined;
  private disposalPromise: Promise<void> | undefined;
  private finishDisposal: (() => void) | undefined;

  constructor(maxQueuedJobs = 16) {
    if (
      typeof maxQueuedJobs !== "number" ||
      !Number.isInteger(maxQueuedJobs) ||
      maxQueuedJobs < 0
    ) {
      throw createMavioError("INVALID_OPTIONS", "maxQueuedJobs must be a nonnegative integer.", {
        details: { reason: "INVALID_QUEUE_LIMIT" },
      });
    }

    this.maxQueuedJobs = maxQueuedJobs;
  }

  dispose(): Promise<void> {
    if (this.disposalPromise !== undefined) {
      return this.disposalPromise;
    }

    this.disposed = true;

    // Store the promise before cancellation can trigger callbacks.
    this.disposalPromise = new Promise<void>((resolve) => {
      this.finishDisposal = resolve;
    });

    for (const entry of [...this.waiting]) {
      entry.cancel();
    }

    this.activeEntry?.cancel();

    if (!this.active) {
      this.finishDisposal?.();
      this.finishDisposal = undefined;
    }

    return this.disposalPromise;
  }

  submit<T>(
    task: (signal: AbortSignal, beginCommit: () => boolean) => T | Promise<T>,
    signal?: AbortSignal,
    onAccepted?: () => void,
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(createMavioError("DISPOSED", "The client queue is disposed."));
    }
    // Pre-aborted submissions take precedence over queue capacity.
    if (signal?.aborted) {
      return Promise.reject(createMavioError("CANCELLED", "Request was already cancelled."));
    }

    if (this.active && this.waiting.length >= this.maxQueuedJobs) {
      return Promise.reject(
        createMavioError("QUEUE_FULL", "The client queue is full.", {
          details: {
            reason: "QUEUE_CAPACITY",
            maxQueuedJobs: this.maxQueuedJobs,
          },
        }),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let state: "queued" | "active" | "settled" = "queued";
      let cancelled = false;

      let committed = false;

      let admitted = false;

      const notifyAccepted = (): void => {
        if (admitted) return;
        admitted = true;

        try {
          onAccepted?.();
        } catch {
          // Admission observers cannot interrupt queue bookkeeping.
        }
      };

      const beginCommit = (): boolean => {
        if (state !== "active" || cancelled || committed) {
          return false;
        }

        committed = true;
        return true;
      };

      const detach = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };

      const entry: QueueEntry = {
        cancel: () => onAbort(),
        start: (): void => {
          this.active = true;
          this.activeEntry = entry;
          state = "active";

          notifyAccepted();

          const run = async (): Promise<void> => {
            try {
              if (cancelled) {
                throw createMavioError("CANCELLED", "Task was cancelled before starting.");
              }

              const result = await task(controller.signal, beginCommit);

              if (cancelled) {
                reject(
                  createMavioError("CANCELLED", "Active task was cancelled.", {
                    stage: "running",
                  }),
                );
              } else {
                resolve(result);
              }
            } catch (cause) {
              if (cancelled && !isPreservedFailure(cause)) {
                reject(
                  createMavioError("CANCELLED", "Active task was cancelled.", {
                    stage: "running",
                    cause,
                  }),
                );
              } else {
                reject(cause);
              }
            } finally {
              state = "settled";
              detach();

              const next = this.waiting.shift();
              if (next === undefined) {
                this.active = false;
                this.activeEntry = undefined;

                if (this.disposed) {
                  this.finishDisposal?.();
                  this.finishDisposal = undefined;
                }
              } else {
                next.start();
              }
            }
          };

          void run();
        },
      };

      const onAbort = (): void => {
        if (state === "settled" || cancelled || committed) return;

        cancelled = true;

        if (state === "queued") {
          const index = this.waiting.indexOf(entry);
          if (index !== -1) this.waiting.splice(index, 1);

          state = "settled";
          detach();
          reject(createMavioError("CANCELLED", "Queued task was cancelled."));
          return;
        }

        // The task must observe this signal and finish required cleanup.
        // Do not release the active slot here.
        controller.abort(signal?.reason);
      };

      signal?.addEventListener("abort", onAbort, { once: true });

      // Also handles an abort observed while registering the listener.
      if (signal?.aborted) {
        onAbort();
        return;
      }

      if (this.active) {
        this.waiting.push(entry);
        notifyAccepted();
      } else {
        entry.start();
      }
    });
  }
}
