import { createMavioError } from "../../core/errors.js";
import {
  validateThumbnailOutput,
  type ThumbnailOutputExpectation,
} from "../shared/thumbnail-output.js";
import type { BrowserProbeDetails } from "./probe-details.js";

export type BrowserThumbnailOutputExpectation = ThumbnailOutputExpectation;

/**
 * Checks metadata, byte size and bounded image structure.
 * Does not replace decoding or verify PNG CRCs/compressed payloads.
 */
export function validateBrowserThumbnailOutput(
  output: BrowserProbeDetails,
  expected: BrowserThumbnailOutputExpectation,
  bytes: Uint8Array,
  jobId?: string,
): void {
  validateThumbnailOutput(output, expected, jobId);

  function invalid(reason: string): never {
    throw createMavioError(
      "EXECUTION_FAILED",
      "The encoded browser thumbnail failed byte validation.",
      {
        stage: "finalizing",
        operation: "thumbnail",
        jobId,
        details: { reason, preset: expected.preset },
      },
    );
  }

  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== output.metadata.sizeBytes) {
    invalid("OUTPUT_BYTE_SIZE_MISMATCH");
  }

  if (expected.preset === "jpeg-balanced-v1") {
    if (
      bytes.length < 5 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[2] !== 0xff ||
      bytes[bytes.length - 2] !== 0xff ||
      bytes[bytes.length - 1] !== 0xd9
    ) {
      invalid("INVALID_JPEG_SIGNATURE");
    }

    return;
  }

  const signature = [137, 80, 78, 71, 13, 10, 26, 10];

  if (bytes.length < 45 || !signature.every((value, index) => bytes[index] === value)) {
    invalid("INVALID_PNG_SIGNATURE");
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

  if (view.getUint32(8, false) !== 13 || fourCC(12) !== "IHDR") {
    invalid("INVALID_PNG_STRUCTURE");
  }

  if (
    view.getUint32(16, false) !== expected.width ||
    view.getUint32(20, false) !== expected.height ||
    bytes[24] !== 8 ||
    bytes[25] !== 2 ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    bytes[28] !== 0
  ) {
    invalid("OUTPUT_IMAGE_HEADER_MISMATCH");
  }

  let offset = 8;
  let imageDataBytes = 0;
  let ended = false;

  while (offset < bytes.length) {
    if (bytes.length - offset < 12) {
      invalid("INVALID_PNG_STRUCTURE");
    }

    const size = view.getUint32(offset, false);
    const kind = fourCC(offset + 4);
    const next = offset + 12 + size;

    if (next > bytes.length) {
      invalid("INVALID_PNG_STRUCTURE");
    }

    if (
      (kind === "IHDR" && offset !== 8) ||
      kind === "acTL" ||
      kind === "fcTL" ||
      kind === "fdAT"
    ) {
      invalid("INVALID_PNG_STRUCTURE");
    }

    if (kind === "IDAT") {
      imageDataBytes += size;
    }

    if (kind === "IEND") {
      if (size !== 0 || next !== bytes.length || imageDataBytes === 0) {
        invalid("INVALID_PNG_STRUCTURE");
      }

      ended = true;
    }

    offset = next;
  }

  if (!ended) {
    invalid("INVALID_PNG_STRUCTURE");
  }
}
