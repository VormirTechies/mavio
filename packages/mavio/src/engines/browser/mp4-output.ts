import { createMavioError } from "../../core/errors.js";
import { validateNativeMp4Output, type NativeMp4OutputExpectation } from "../shared/mp4-output.js";
import type { BrowserProbeDetails } from "./probe-details.js";

export type BrowserMp4OutputExpectation = Omit<
  NativeMp4OutputExpectation,
  "requireNormalizedGeometry"
>;

export function validateBrowserMp4Output(
  output: BrowserProbeDetails,
  expected: BrowserMp4OutputExpectation,
  bytes: Uint8Array,
  jobId?: string,
): void {
  validateNativeMp4Output(
    output,
    {
      ...expected,
      requireNormalizedGeometry: true,
    },
    jobId,
  );

  function invalid(reason: string): never {
    throw createMavioError("EXECUTION_FAILED", "The encoded browser MP4 failed byte validation.", {
      stage: "finalizing",
      jobId,
      details: {
        reason,
        preset: expected.preset ?? "video-balanced-v1",
      },
    });
  }

  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== output.metadata.sizeBytes) {
    invalid("OUTPUT_BYTE_SIZE_MISMATCH");
  }

  if (bytes.byteLength < 16) {
    invalid("INVALID_MP4_SIGNATURE");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  function fourCC(offset: number): string {
    return String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    );
  }

  const boxSize = view.getUint32(0, false);

  // The pinned MP4 writer produces a normal-sized leading ftyp box.
  // Extended-size boxes and alternative layouts are outside this route.
  if (fourCC(4) !== "ftyp" || boxSize < 16 || boxSize > bytes.byteLength || boxSize % 4 !== 0) {
    invalid("INVALID_MP4_SIGNATURE");
  }

  const majorBrand = fourCC(8);

  if (!["isom", "iso2", "avc1", "mp41", "mp42"].includes(majorBrand)) {
    invalid("UNSUPPORTED_MP4_BRAND");
  }
}
