import type { MediaMetadata as MavioMediaMetadata } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import { prepareNativeMp4File } from "./mp4-file.js";

/**
 * The caller owns workspace cleanup and the commit gate.
 * Returned bytes must not be published before those steps succeed.
 */
export async function prepareNativeMp4Bytes(
  options: Parameters<typeof prepareNativeMp4File>[0],
  dependencies: Parameters<typeof prepareNativeMp4File>[1] = {},
): Promise<{ bytes: Uint8Array; metadata: MavioMediaMetadata }> {
  const { plan, workspace, context } = options;

  function checkAbort(): void {
    if (context.signal.aborted) {
      throw createMavioError("CANCELLED", "Native byte export was cancelled.", {
        stage: "finalizing",
        jobId: context.jobId,
        cause: context.signal.reason,
      });
    }
  }

  checkAbort();

  if (plan.output.kind !== "bytes") {
    throw createMavioError("UNSUPPORTED_CAPABILITY", "This route requires byte output.", {
      stage: "preparing",
      jobId: context.jobId,
      details: { reason: "UNSUPPORTED_NATIVE_IO" },
    });
  }

  const prepared = await prepareNativeMp4File(options, dependencies);
  checkAbort();

  const bytes = await workspace.readOutput(context);
  checkAbort();

  if (bytes.byteLength !== prepared.metadata.sizeBytes) {
    throw createMavioError(
      "EXECUTION_FAILED",
      "Encoded output size changed between probing and reading.",
      {
        stage: "finalizing",
        jobId: context.jobId,
        details: { reason: "OUTPUT_SIZE_CHANGED" },
      },
    );
  }

  return { bytes, metadata: prepared.metadata };
}
