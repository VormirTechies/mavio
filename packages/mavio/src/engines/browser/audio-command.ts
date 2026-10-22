import type { ProcessingPlan } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import { buildBrowserAudioEncoding } from "./audio-encoding.js";
import { validateBrowserAudioSource } from "./audio-source.js";
import type { BrowserInventory } from "./inventory.js";
import type { BrowserProbeDetails } from "./probe-details.js";
import { buildBrowserAudioTrimPlan } from "./audio-trim-plan.js";

interface CommandOptions {
  plan: ProcessingPlan;
  source: BrowserProbeDetails;
  inventory: BrowserInventory;
  inputPath: string;
  outputPath: string;
}

export function buildBrowserAudioCommand({
  plan,
  source,
  inventory,
  inputPath,
  outputPath,
}: CommandOptions): readonly string[] {
  function invalid(reason: string): never {
    throw createMavioError("INVALID_OPTIONS", "The browser audio command options are invalid.", {
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
      "This route requires a browser audio export preset.",
      {
        stage: "preparing",
        details: {
          reason: "UNSUPPORTED_BROWSER_ENCODING",
        },
      },
    );
  }

  const preset = terminal.preset;
  const format = preset === "audio-balanced-v1" ? "mp3" : "wav";

  if (terminal.format !== format) {
    invalid("TERMINAL_FORMAT_MISMATCH");
  }

  if (
    !["bytes", "blob"].includes(plan.input.kind) ||
    !["bytes", "blob"].includes(plan.output.kind)
  ) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "Browser audio requires byte or Blob input and output.",
      {
        stage: "preparing",
        details: {
          reason: "UNSUPPORTED_BROWSER_IO",
        },
      },
    );
  }

  let streamIndex: number | undefined;
  const seen = new Set<string>();

  for (const [operationIndex, transformation] of plan.transformations.entries()) {
    // Consecutive trims are resolved together against the source timeline.
    if (transformation.type === "trim") continue;

    if (
      transformation.type !== "extractAudio" &&
      transformation.type !== "convert" &&
      transformation.type !== "compress"
    ) {
      throw createMavioError(
        "UNSUPPORTED_CAPABILITY",
        "This browser audio transformation is not implemented yet.",
        {
          stage: "preparing",
          operation: transformation.type,
          details: {
            reason: "BROWSER_AUDIO_TRANSFORMATION_PENDING",
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

  if (
    typeof inputPath !== "string" ||
    !/^\/mavio-[A-Za-z0-9-]+\/input\.bin$/.test(inputPath) ||
    outputPath !== `${inputPath.slice(0, -"input.bin".length)}output.${format}`
  ) {
    invalid("INVALID_BROWSER_COMMAND_PATH");
  }

  const selected = validateBrowserAudioSource(source, inventory, preset, streamIndex);

  const selectedStream = source.metadata.streams.find(
    (stream) => stream.index === selected.audioStreamIndex,
  )!;

  // PCM WAV has an implicit zero origin when no timestamp is reported.
  const sourceOrigin =
    source.formatStartTimeSeconds ??
    (source.metadata.container === "wav" && selectedStream.codec === "pcm_s16le" ? 0 : undefined);

  const trim = buildBrowserAudioTrimPlan(
    plan.transformations,
    source.metadata.durationSeconds,
    sourceOrigin,
    inventory,
  );

  return Object.freeze([
    "-hide_banner",
    "-v",
    "error",
    "-xerror",
    ...(trim?.inputArgs ?? []),
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
    ...(trim === undefined ? [] : ["-af", trim.audio]),
    ...buildBrowserAudioEncoding(preset, inventory),
    outputPath,
  ]);
}
