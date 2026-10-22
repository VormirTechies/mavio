import type { ProcessingPlan } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import type { BrowserInventory } from "./inventory.js";
import { buildBrowserMp4Encoding } from "./mp4-encoding.js";
import { validateBrowserMp4Source } from "./mp4-source.js";
import type { BrowserProbeDetails } from "./probe-details.js";
import { buildBrowserTrimPlan } from "./trim-plan.js";
import { buildBrowserResizePlan } from "./resize-plan.js";

interface CommandOptions {
  plan: ProcessingPlan;
  source: BrowserProbeDetails;
  inventory: BrowserInventory;
  inputPath: string;
  outputPath: string;
}

export function buildBrowserMp4Command({
  plan,
  source,
  inventory,
  inputPath,
  outputPath,
}: CommandOptions): readonly string[] {
  function unsupported(reason: string): never {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The plan is outside the current browser MP4 route.",
      {
        stage: "preparing",
        details: { reason },
      },
    );
  }

  if (
    plan.terminal.type !== "export" ||
    plan.terminal.format !== "mp4" ||
    (plan.terminal.preset !== "video-balanced-v1" && plan.terminal.preset !== "video-small-v1")
  ) {
    unsupported("UNSUPPORTED_BROWSER_ENCODING");
  }

  const preset = plan.terminal.preset;

  if (
    !["bytes", "blob"].includes(plan.input.kind) ||
    !["bytes", "blob"].includes(plan.output.kind)
  ) {
    unsupported("UNSUPPORTED_BROWSER_IO");
  }

  for (const transformation of plan.transformations) {
    if (transformation.type === "trim" || transformation.type === "resize") {
      continue;
    }

    if (transformation.type !== "convert" && transformation.type !== "compress") {
      unsupported("BROWSER_TRANSFORMATION_PENDING");
    }

    if (
      transformation.options.preset !== preset ||
      (transformation.type === "convert" && transformation.options.format !== "mp4")
    ) {
      unsupported("UNSUPPORTED_BROWSER_ENCODING");
    }
  }

  if (
    typeof inputPath !== "string" ||
    !/^\/mavio-[A-Za-z0-9-]+\/input\.bin$/.test(inputPath) ||
    outputPath !== `${inputPath.slice(0, -"input.bin".length)}output.mp4`
  ) {
    throw createMavioError(
      "INVALID_OPTIONS",
      "Browser MP4 paths must use separate files in one owned workspace.",
      {
        stage: "preparing",
        details: { reason: "INVALID_BROWSER_COMMAND_PATH" },
      },
    );
  }

  const selected = validateBrowserMp4Source(source, inventory, preset);
  const hasAudio = selected.audioStreamIndex !== undefined;

  const trim = buildBrowserTrimPlan(
    plan.transformations,
    source.metadata.durationSeconds,
    source.formatStartTimeSeconds,
    hasAudio,
    inventory,
  );

  const video = source.metadata.streams.find(
    (stream) => stream.index === selected.videoStreamIndex,
  )!;

  const resize = buildBrowserResizePlan(
    {
      width: video.width!,
      height: video.height!,
    },
    plan.transformations,
    inventory,
  );

  const args = [
    "-hide_banner",
    "-v",
    "error",
    "-xerror",
    ...(trim?.inputArgs ?? []),
    "-noautorotate",
    "-protocol_whitelist",
    "file",
    "-i",
    inputPath,
    "-map",
    `0:${selected.videoStreamIndex}`,
  ];

  if (selected.audioStreamIndex !== undefined) {
    const audio = source.metadata.streams.find(
      (stream) => stream.index === selected.audioStreamIndex,
    )!;

    const details = source.streams.find((stream) => stream.index === selected.audioStreamIndex)!;

    args.push(
      "-map",
      `0:${selected.audioStreamIndex}`,
      "-ar:a:0",
      String(audio.sampleRate),
      "-ac:a:0",
      String(audio.channels),
      "-channel_layout:a:0",
      details.channelLayout!,
    );
  }

  args.push(
    "-map_metadata",
    "-1",
    "-map_metadata:s",
    "-1",
    "-map_chapters",
    "-1",
    "-sn",
    "-dn",
    ...buildBrowserMp4Encoding(preset, inventory, hasAudio),
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-color_range",
    "tv",
  );

  const videoFilters: string[] = [];

  if (trim !== undefined) {
    videoFilters.push(trim.video);
  }

  if (resize !== undefined) {
    videoFilters.push(resize.video);
  }

  if (videoFilters.length > 0) {
    args.push("-vf", videoFilters.join(","));
  }

  if (trim !== undefined) {
    if (trim.audio !== undefined) {
      args.push("-af", trim.audio);
    }

    args.push(...trim.mp4OutputArgs);
  }

  args.push(outputPath);

  return Object.freeze(args);
}
