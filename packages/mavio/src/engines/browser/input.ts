import type { EngineContext, MediaInput } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import { captureInput } from "../../core/input.js";

type BlobReader = (blob: Blob) => Promise<ArrayBuffer>;

export async function prepareBrowserInput(
  supplied: MediaInput,
  context: EngineContext,
  readBlob: BlobReader = (blob) => blob.arrayBuffer(),
): Promise<Uint8Array> {
  function cancelled() {
    return createMavioError("CANCELLED", "Browser input preparation was cancelled.", {
      stage: "preparing",
      jobId: context.jobId,
      cause: context.signal.reason,
    });
  }

  function checkAbort(): void {
    if (context.signal.aborted) throw cancelled();
  }

  checkAbort();

  const input = captureInput(supplied);

  if (input.kind === "path") {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "Browser engines cannot read filesystem paths.",
      {
        stage: "preparing",
        jobId: context.jobId,
        details: { reason: "BROWSER_PATH_UNSUPPORTED" },
      },
    );
  }

  if (input.kind === "bytes") {
    // Do not use input.bytes.slice(): Buffer.slice() shares storage.
    // This copies only the visible view, excluding surrounding bytes.
    const owned = new Uint8Array(input.bytes);
    checkAbort();
    return owned;
  }

  const blob = input.blob;
  let rejectAbort: (reason: unknown) => void = () => {};

  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });

  function onAbort(): void {
    rejectAbort(cancelled());
  }

  context.signal.addEventListener("abort", onAbort, { once: true });

  try {
    checkAbort();

    const buffer = await Promise.race([
      Promise.resolve().then(() => {
        checkAbort();
        return readBlob(blob);
      }),
      aborted,
    ]);

    checkAbort();

    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== blob.size) {
      throw createMavioError("IO_ERROR", "Browser input read returned an unexpected byte count.", {
        stage: "preparing",
        jobId: context.jobId,
        details: { reason: "BLOB_READ_SIZE_MISMATCH" },
      });
    }

    return new Uint8Array(buffer);
  } catch (cause) {
    if (context.signal.aborted) throw cancelled();

    throw createMavioError("IO_ERROR", "Could not read the browser input.", {
      stage: "preparing",
      jobId: context.jobId,
      cause,
    });
  } finally {
    context.signal.removeEventListener("abort", onAbort);
  }
}
