import { isAbsolute, normalize } from "node:path";
import { platform } from "node:process";
import type { ProcessingPlan } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import { buildNativeAudioEncoding } from "./audio-encoding.js";
import { validateNativeAudioSource } from "./audio-source.js";
import type { NativeInventory } from "./inventory.js";
import type { NativeProbeDetails } from "./probe-details.js";
import { resolveNativeTrimRange } from "./trim-range.js";
import { buildNativeAudioTrimFilters } from "./audio-trim-filters.js";

interface CommandOptions {
  plan: ProcessingPlan;
  source: NativeProbeDetails;
  inventory: NativeInventory;
  inputPath: string;
  /** A new adapter-owned intermediate file, not the final public target. */
  outputPath: string;
}

export function buildNativeAudioCommand({
  plan,
  source,
  inventory,
  inputPath,
  outputPath,
}: CommandOptions): readonly string[] {
  function invalid(reason: string): never {
    throw createMavioError("INVALID_OPTIONS", "The native audio command options are invalid.", {
      stage: "preparing",
      details: { reason },
    });
  }

  const terminal = plan.terminal;

  if (
    terminal.type !== "export" ||
    (terminal.preset !== "audio-balanced-v1" && terminal.preset !== "audio-pcm-v1")
  ) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "This route requires an audio export preset.",
      {
        stage: "preparing",
        details: { reason: "UNSUPPORTED_NATIVE_ENCODING" },
      },
    );
  }

  const preset = terminal.preset;
  const format = preset === "audio-balanced-v1" ? "mp3" : "wav";

  if (terminal.format !== format) {
    invalid("TERMINAL_FORMAT_MISMATCH");
  }

  let streamIndex: number | undefined;
  const seen = new Set<string>();

  for (const [operationIndex, transformation] of plan.transformations.entries()) {
    if (transformation.type === "trim") continue;
    if (
      transformation.type !== "extractAudio" &&
      transformation.type !== "convert" &&
      transformation.type !== "compress"
    ) {
      throw createMavioError(
        "UNSUPPORTED_CAPABILITY",
        "This native audio route does not support the transformation yet.",
        {
          stage: "preparing",
          operation: transformation.type,
          details: {
            reason: "NATIVE_TRANSFORMATION_PENDING",
            operationIndex,
          },
        },
      );
    }

    if (seen.has(transformation.type)) {
      invalid("DUPLICATE_AUDIO_TRANSFORMATION");
    }

    seen.add(transformation.type);

    if (transformation.type === "extractAudio") {
      streamIndex = transformation.options.streamIndex;
      continue;
    }

    if (
      transformation.options.preset !== preset ||
      (transformation.type === "convert" && transformation.options.format !== format)
    ) {
      invalid("AUDIO_ENCODING_MISMATCH");
    }
  }

  for (const path of [inputPath, outputPath]) {
    if (
      typeof path !== "string" ||
      path.includes("\0") ||
      !isAbsolute(path) ||
      (platform === "win32" && !/^(?:[a-z]:[\\/]|\\\\)/i.test(path))
    ) {
      invalid("INVALID_NATIVE_COMMAND_PATH");
    }
  }

  const comparable = (path: string): string =>
    platform === "win32" ? normalize(path).toLowerCase() : normalize(path);

  if (comparable(inputPath) === comparable(outputPath)) {
    invalid("INPUT_OUTPUT_PATH_CONFLICT");
  }

  const selected = validateNativeAudioSource(source, preset, streamIndex);
  const encoding = buildNativeAudioEncoding(preset, inventory);

  const trimRange = resolveNativeTrimRange(plan.transformations, source.metadata.durationSeconds);

  const trimFilters =
    trimRange === undefined
      ? undefined
      : buildNativeAudioTrimFilters(trimRange, source.formatStartTimeSeconds, inventory);

  return Object.freeze([
    "-hide_banner",
    "-v",
    "error",
    "-nostdin",
    "-n",
    "-xerror",
    ...(trimFilters?.inputArgs ?? []),
    "-protocol_whitelist",
    "file",
    "-i",
    inputPath,
    "-map",
    `0:${selected.audioStreamIndex}`,
    "-vn",
    "-sn",
    "-dn",
    "-ar:a:0",
    String(selected.sampleRate),
    "-ac:a:0",
    String(selected.channels),
    "-channel_layout:a:0",
    selected.channelLayout,
    "-map_metadata",
    "-1",
    "-map_metadata:s",
    "-1",
    "-map_chapters",
    "-1",
    ...(trimFilters === undefined ? [] : ["-af", trimFilters.audio]),
    ...encoding,
    outputPath,
  ]);
}
