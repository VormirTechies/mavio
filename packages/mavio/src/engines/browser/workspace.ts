import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { createMavioError } from "../../core/errors.js";

type WorkspaceWorker = Pick<FFmpeg, "createDir" | "listDir" | "deleteFile" | "deleteDir">;

export interface BrowserWorkspace {
  readonly directory: string;
  readonly inputPath: string;
  readonly probePath: string;
  cleanup(): Promise<void>;
}

/**
 * The caller owns this workspace after creation succeeds.
 * Call cleanup only after pending operations using it have settled.
 * This helper never terminates the shared worker.
 */
export async function createBrowserWorkspace(
  worker: WorkspaceWorker,
  jobId?: string,
  identifier: string = crypto.randomUUID(),
): Promise<BrowserWorkspace> {
  if (!/^[a-zA-Z0-9-]+$/.test(identifier)) {
    throw createMavioError("INVALID_OPTIONS", "Invalid browser workspace identifier.", {
      stage: "preparing",
      jobId,
    });
  }

  const directory = `/mavio-${identifier}`;

  try {
    // mkdir must succeed before this helper claims ownership.
    // An existing directory must never be reused or removed.
    await worker.createDir(directory);
  } catch (cause) {
    throw createMavioError("IO_ERROR", "Could not create the browser workspace.", {
      stage: "preparing",
      jobId,
      cause,
    });
  }

  let cleaned = false;
  let cleanupPromise: Promise<void> | undefined;

  async function removeContents(): Promise<void> {
    const entries = await worker.listDir(directory);
    const failures: unknown[] = [];

    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") continue;

      // Workspaces are flat. Never traverse directories or unsafe names.
      if (
        entry.isDir ||
        entry.name.length === 0 ||
        entry.name.includes("/") ||
        entry.name.includes("\\") ||
        entry.name.includes("\0")
      ) {
        failures.push(new Error("Unexpected browser workspace entry."));
        continue;
      }

      try {
        await worker.deleteFile(`${directory}/${entry.name}`);
      } catch (cause) {
        failures.push(cause);
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, "Some browser workspace entries could not be removed.");
    }

    await worker.deleteDir(directory);
    cleaned = true;
  }

  function cleanup(): Promise<void> {
    if (cleaned) return Promise.resolve();
    if (cleanupPromise !== undefined) return cleanupPromise;

    cleanupPromise = Promise.resolve()
      .then(removeContents)
      .catch((cause) => {
        throw createMavioError("CLEANUP_FAILED", "Could not remove the browser workspace.", {
          stage: "finalizing",
          jobId,
          cause,
        });
      })
      .finally(() => {
        // A failed attempt may be retried after the underlying issue clears.
        cleanupPromise = undefined;
      });

    return cleanupPromise;
  }

  return Object.freeze({
    directory,
    inputPath: `${directory}/input.bin`,
    probePath: `${directory}/probe.json`,
    cleanup,
  });
}
