import { link, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { platform } from "node:process";
import type { ExecutionEngineContext } from "../../contracts.js";
import { createMavioError, preserveFailure } from "../../core/errors.js";

interface Dependencies {
  link?: typeof link;
}

/**
 * Publishes a closed, validated file from an adapter-owned staging directory.
 * The caller owns staging cleanup. Never modify staging contents after success.
 */
export async function publishNativeFile(
  stagedPath: string,
  targetPath: string,
  context: Pick<ExecutionEngineContext, "jobId" | "signal" | "beginCommit">,
  dependencies: Dependencies = {},
): Promise<void> {
  function cancelled(): never {
    throw createMavioError("CANCELLED", "File publication was cancelled.", {
      stage: "finalizing",
      jobId: context.jobId,
      cause: context.signal.reason,
    });
  }

  if (context.signal.aborted) cancelled();

  for (const path of [stagedPath, targetPath]) {
    if (
      typeof path !== "string" ||
      path.includes("\0") ||
      !isAbsolute(path) ||
      (platform === "win32" && !/^(?:[a-z]:[\\/]|\\\\)/i.test(path))
    ) {
      throw createMavioError(
        "INVALID_OPTIONS",
        "Publication requires fully qualified local paths.",
        {
          stage: "finalizing",
          jobId: context.jobId,
          details: { reason: "INVALID_PUBLICATION_PATH" },
        },
      );
    }
  }

  let staged;

  try {
    staged = await lstat(stagedPath);
  } catch (cause) {
    throw createMavioError("IO_ERROR", "Could not inspect the staged output.", {
      stage: "finalizing",
      jobId: context.jobId,
      details: { reason: "STAGED_OUTPUT_INSPECTION_FAILED" },
      cause,
    });
  }

  if (context.signal.aborted) cancelled();

  if (!staged.isFile() || staged.size <= 0) {
    throw createMavioError(
      "EXECUTION_FAILED",
      "Publication requires a non-empty regular staging file.",
      {
        stage: "finalizing",
        jobId: context.jobId,
        details: { reason: "INVALID_STAGED_OUTPUT" },
      },
    );
  }

  if (!context.beginCommit()) cancelled();

  // No cancellation checks after the commit gate grants publication.
  // link() creates a new directory entry without replacing an existing one.
  try {
    await (dependencies.link ?? link)(stagedPath, targetPath);
  } catch (cause) {
    const exists =
      typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST";

    throw preserveFailure(
      createMavioError(
        exists ? "OUTPUT_EXISTS" : "IO_ERROR",
        exists ? "The output path already exists." : "Could not publish the output file.",
        {
          stage: "finalizing",
          jobId: context.jobId,
          details: {
            reason: exists ? "OUTPUT_ALREADY_EXISTS" : "PUBLICATION_FAILED",
          },
          cause,
        },
      ),
    );
  }
}
