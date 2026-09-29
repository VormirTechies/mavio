import type { MediaInput } from "../contracts.js";
import { createMavioError } from "./errors.js";

function invalid(reason: string, message: string): never {
  throw createMavioError("INVALID_INPUT", message, {
    details: { reason },
  });
}

export function captureInput(value: unknown): MediaInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid("INVALID_SHAPE", "Input must be a media input object.");
  }

  const input = value as Record<string, unknown>;

  switch (input.kind) {
    case "bytes": {
      const bytes = input.bytes;
      const name = input.name;

      if (!(bytes instanceof Uint8Array)) {
        return invalid("INVALID_BYTES", "Input bytes must be a Uint8Array.");
      }

      if (bytes.byteLength === 0) {
        return invalid("EMPTY_BYTES", "Input bytes must not be empty.");
      }

      if (name !== undefined && typeof name !== "string") {
        return invalid("INVALID_NAME", "Input name must be a string.");
      }

      // Capture the descriptor, retaining the caller-owned buffer.
      return Object.freeze(
        name === undefined
          ? { kind: "bytes" as const, bytes }
          : { kind: "bytes" as const, bytes, name },
      );
    }

    case "blob": {
      const blob = input.blob;

      if (typeof Blob === "undefined" || !(blob instanceof Blob)) {
        return invalid("INVALID_BLOB", "Input blob must be a Blob or File.");
      }

      if (blob.size === 0) {
        return invalid("EMPTY_BLOB", "Input blob must not be empty.");
      }

      return Object.freeze({ kind: "blob" as const, blob });
    }

    case "path": {
      const path = input.path;

      if (typeof path !== "string") {
        return invalid("INVALID_PATH", "Input path must be a string.");
      }

      if (path.length === 0) {
        return invalid("EMPTY_PATH", "Input path must not be empty.");
      }

      if (path.includes("\0")) {
        return invalid("INVALID_PATH", "Input path must not contain a null character.");
      }

      // Preserve spelling and spaces; resolution belongs to the Node runtime.
      return Object.freeze({ kind: "path" as const, path });
    }

    default:
      return invalid("INVALID_KIND", "Input kind must be bytes, blob, or path.");
  }
}
