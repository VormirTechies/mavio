/**
 * Reviewed default Native input formats.
 * This demuxer restriction is not a filesystem or process sandbox.
 * MOV external-reference options retain their disabled defaults.
 */
export const NATIVE_INPUT_DEMUXERS = Object.freeze([
  "mov",
  "matroska",
  "wav",
  "mp3",
  "flac",
  "jpeg_pipe",
  "png_pipe",
]);

const readableNames = new Set([
  ...NATIVE_INPUT_DEMUXERS,
  "mp4",
  "m4a",
  "3gp",
  "3g2",
  "mj2",
  "webm",
  "image2", // Metadata only, with pattern expansion disabled.
]);

export function restrictNativeReadableContainers(discovered: readonly string[]): readonly string[] {
  return [...new Set(discovered.filter((name) => readableNames.has(name)))];
}

export const NATIVE_INPUT_ARGUMENTS: readonly string[] = Object.freeze([
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  NATIVE_INPUT_DEMUXERS.join(","),
]);

/**
 * FFprobe can select image2 for a single generated JPEG.
 * Disable pattern expansion; encoding retains the narrower input policy.
 */
export const NATIVE_PROBE_INPUT_ARGUMENTS: readonly string[] = Object.freeze([
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  [...NATIVE_INPUT_DEMUXERS, "image2"].join(","),
  "-pattern_type",
  "none",
]);
