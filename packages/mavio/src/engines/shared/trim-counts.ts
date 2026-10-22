import { createMavioError } from "../../core/errors.js";

type SelectionStream =
  { readonly kind: "video" } | { readonly kind: "audio"; readonly channels: number };

/**
 * Parses a single mapped stream:
 * rawvideo for video, pcm_f32le for audio.
 * Call only after the process completes successfully without error diagnostics.
 */
export function parseNativeTrimCount(
  text: string,
  stream: SelectionStream,
  jobId?: string,
): number {
  function invalid(): never {
    throw createMavioError(
      "EXECUTION_FAILED",
      "Native trim analysis returned malformed frame counts.",
      {
        stage: "preparing",
        operation: "trim",
        jobId,
        details: { reason: "INVALID_TRIM_SELECTION" },
      },
    );
  }

  if (stream.kind === "audio" && (!Number.isSafeInteger(stream.channels) || stream.channels <= 0)) {
    invalid();
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const codec = stream.kind === "video" ? "rawvideo" : "pcm_f32le";

  for (const header of [
    "#format: frame checksums",
    "#version: 2",
    "#hash: MD5",
    `#media_type 0: ${stream.kind}`,
    `#codec_id 0: ${codec}`,
  ]) {
    if (lines.filter((line) => line === header).length !== 1) {
      invalid();
    }
  }

  // This parser handles exactly one output stream.
  const mediaHeaders = lines.filter((line) => line.startsWith("#media_type "));
  const codecHeaders = lines.filter((line) => line.startsWith("#codec_id "));

  if (mediaHeaders.length !== 1 || codecHeaders.length !== 1) {
    invalid();
  }

  let count = 0;

  for (const line of lines) {
    if (line.startsWith("#")) continue;

    const fields = line.split(",").map((field) => field.trim());

    if (
      fields.length !== 6 ||
      !fields.slice(0, 5).every((field) => /^-?\d+$/.test(field)) ||
      !/^[a-f0-9]{32}$/i.test(fields[5]!)
    ) {
      invalid();
    }

    const values = fields.slice(0, 5).map(Number);

    if (!values.every(Number.isSafeInteger)) {
      invalid();
    }

    const streamIndex = values[0]!;
    const duration = values[3]!;
    const size = values[4]!;

    if (streamIndex !== 0 || duration < 0 || size <= 0) {
      invalid();
    }

    let increment = 1;

    if (stream.kind === "audio") {
      const bytesPerSampleFrame = 4 * stream.channels;

      if (!Number.isSafeInteger(bytesPerSampleFrame) || size % bytesPerSampleFrame !== 0) {
        invalid();
      }

      // A sample frame contains one sample per channel.
      increment = size / bytesPerSampleFrame;
    }

    count += increment;

    if (!Number.isSafeInteger(count)) {
      invalid();
    }
  }

  return count;
}
