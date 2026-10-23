import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { EngineContext } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";

interface Dependencies {
  remove?: (directory: string) => Promise<void>;
  read?: (path: string, signal: AbortSignal) => Promise<Uint8Array>;
}

export interface NativeWorkspace {
  writeInput(bytes: Uint8Array, context: Pick<EngineContext, "jobId" | "signal">): Promise<string>;
  dispose(): Promise<void>;
  getOutputPath(): string;
  readOutput(context: Pick<EngineContext, "jobId" | "signal">): Promise<Uint8Array>;
}

export async function createNativeWorkspace(
  dependencies: Dependencies = {},
  parentDirectory: string = tmpdir(),
): Promise<NativeWorkspace> {
  let root: string;
  let directory: string;

  try {
    root = resolve(await realpath(parentDirectory));
    directory = resolve(await mkdtemp(join(root, "mavio-input-")));
  } catch (cause) {
    throw createMavioError("IO_ERROR", "Could not create a native workspace.", {
      stage: "preparing",
      details: { reason: "WORKSPACE_CREATE_FAILED" },
      cause,
    });
  }

  const remove =
    dependencies.remove ?? ((target: string) => rm(target, { recursive: true, force: true }));

  const read =
    dependencies.read ?? ((path: string, signal: AbortSignal) => readFile(path, { signal }));

  const reading = new Set<Promise<Uint8Array>>();

  let closed = false;
  let used = false;
  let writing: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;

  return {
    async writeInput(bytes, context) {
      if (closed) {
        throw createMavioError("DISPOSED", "Native workspace is closed.");
      }

      if (context.signal.aborted) {
        throw createMavioError("CANCELLED", "Input staging was cancelled.", {
          stage: "preparing",
          jobId: context.jobId,
          cause: context.signal.reason,
        });
      }

      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        throw createMavioError("INVALID_INPUT", "Input bytes must not be empty.", {
          stage: "preparing",
          jobId: context.jobId,
        });
      }

      if (used) {
        throw createMavioError("INVALID_INPUT", "A native workspace accepts only one input.", {
          stage: "preparing",
          jobId: context.jobId,
        });
      }

      // Copy only the supplied view, without transferring its buffer.
      const snapshot = new Uint8Array(bytes);
      const inputPath = join(directory, "input.bin");
      used = true;

      try {
        writing = writeFile(inputPath, snapshot, {
          flag: "wx",
          signal: context.signal,
        });

        await writing;
      } catch (cause) {
        const aborted = cause instanceof Error && cause.name === "AbortError";

        throw createMavioError(
          aborted ? "CANCELLED" : "IO_ERROR",
          aborted ? "Input staging was cancelled." : "Could not stage input bytes.",
          {
            stage: "preparing",
            jobId: context.jobId,
            details: { reason: "INPUT_STAGING_FAILED" },
            cause,
          },
        );
      } finally {
        writing = undefined;
      }

      if (context.signal.aborted) {
        throw createMavioError("CANCELLED", "Input staging was cancelled.", {
          stage: "preparing",
          jobId: context.jobId,
          cause: context.signal.reason,
        });
      }

      return inputPath;
    },

    getOutputPath() {
      if (closed) {
        throw createMavioError("DISPOSED", "Native workspace is closed.");
      }

      // This does not create the file. FFmpeg requires an unoccupied path.
      return join(directory, "output.mp4");
    },

    async readOutput(context) {
      if (closed) {
        throw createMavioError("DISPOSED", "Native workspace is closed.");
      }

      function checkAbort(): void {
        if (context.signal.aborted) {
          throw createMavioError("CANCELLED", "Output reading was cancelled.", {
            stage: "finalizing",
            jobId: context.jobId,
            cause: context.signal.reason,
          });
        }
      }

      checkAbort();

      const pending = (async (): Promise<Uint8Array> => {
        let bytes: Uint8Array;

        try {
          bytes = await read(join(directory, "output.mp4"), context.signal);
        } catch (cause) {
          const aborted = cause instanceof Error && cause.name === "AbortError";

          throw createMavioError(
            aborted ? "CANCELLED" : "IO_ERROR",
            aborted ? "Output reading was cancelled." : "Could not read encoded output.",
            {
              stage: "finalizing",
              jobId: context.jobId,
              details: { reason: "OUTPUT_READ_FAILED" },
              cause,
            },
          );
        }

        checkAbort();

        if (bytes.byteLength === 0) {
          throw createMavioError("EXECUTION_FAILED", "Encoded output is empty.", {
            stage: "finalizing",
            jobId: context.jobId,
            details: { reason: "EMPTY_ENCODED_OUTPUT" },
          });
        }

        // Return independently owned bytes, not a shared Buffer view.
        return new Uint8Array(bytes);
      })();

      reading.add(pending);

      try {
        return await pending;
      } finally {
        reading.delete(pending);
      }
    },

    dispose() {
      closed = true;

      if (disposal !== undefined) return disposal;

      disposal = Promise.resolve()
        .then(async () => {
          // A cancelled write may still be settling.
          // Its error belongs to writeInput; cleanup still needs to run.
          if (writing !== undefined) {
            await writing.catch(() => {});
          }

          // Reads may remain active after the input write has settled.
          // Their errors belong to readOutput; cleanup must still proceed.
          await Promise.allSettled([...reading]);

          if (dirname(directory) !== root || !basename(directory).startsWith("mavio-input-")) {
            throw new Error("Unexpected native workspace location.");
          }

          await remove(directory);
        })
        .catch((cause: unknown) => {
          // Keep the workspace closed, but allow cleanup to be retried.
          disposal = undefined;

          throw createMavioError("CLEANUP_FAILED", "Could not remove the native workspace.", {
            stage: "finalizing",
            details: { reason: "WORKSPACE_CLEANUP_FAILED" },
            cause,
          });
        });

      return disposal;
    },
  };
}
