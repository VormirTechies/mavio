import { lstat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { platform } from "node:process";
import { createMavioError } from "../../core/errors.js";
import { createNativeWorkspace, type NativeWorkspace } from "./workspace.js";

/**
 * Creates staging beside the requested destination.
 * The caller must retain and dispose the returned workspace.
 */
export async function createNativePathWorkspace(targetPath: string): Promise<NativeWorkspace> {
  if (
    typeof targetPath !== "string" ||
    targetPath.includes("\0") ||
    !isAbsolute(targetPath) ||
    (platform === "win32" && !/^(?:[a-z]:[\\/]|\\\\)/i.test(targetPath))
  ) {
    throw createMavioError(
      "INVALID_OPTIONS",
      "File export requires a fully qualified local destination.",
      {
        stage: "preparing",
        details: { reason: "INVALID_OUTPUT_PATH" },
      },
    );
  }

  let occupied = false;

  try {
    // lstat also detects directories and symbolic links.
    await lstat(targetPath);
    occupied = true;
  } catch (cause) {
    const missing =
      typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

    if (!missing) {
      throw createMavioError("IO_ERROR", "Could not inspect the destination.", {
        stage: "preparing",
        details: { reason: "OUTPUT_INSPECTION_FAILED" },
        cause,
      });
    }
  }

  if (occupied) {
    throw createMavioError("OUTPUT_EXISTS", "The output path already exists.", {
      stage: "preparing",
      details: { reason: "OUTPUT_ALREADY_EXISTS" },
    });
  }

  // Do not create missing destination directories.
  // There is no work after allocation that could throw and lose ownership.
  return createNativeWorkspace({}, dirname(targetPath));
}
