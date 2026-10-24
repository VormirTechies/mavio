import { NATIVE_INPUT_ARGUMENTS } from "./input-policy.js";
import { isAbsolute, normalize } from "node:path";
import { platform } from "node:process";
import type { ProcessingPlan } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import type { NativeInventory } from "./inventory.js";
import { validateBalancedMp4Source } from "./mp4-source.js";
import type { NativeProbeDetails } from "./probe-details.js";
import { buildNativeTrimFilters } from "./trim-filters.js";
import { resolveNativeTrimRange } from "./trim-range.js";
import { buildNativeResizeFilters } from "./resize-filters.js";
import { validateNativeResizeSource } from "./resize-source.js";
import { buildNativeMp4Encoding } from "./mp4-encoding.js";

interface CommandOptions {
  plan: ProcessingPlan;
  source: NativeProbeDetails;
  inventory: NativeInventory;
  inputPath: string;
  /** A new, adapter-owned intermediate file, not the user's final target. */
  outputPath: string;
}

export function buildNativeMp4Command({
  plan,
  source,
  inventory,
  inputPath,
  outputPath,
}: CommandOptions): readonly string[] {
  function unsupported(reason: string): never {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The requested plan is outside the initial native MP4 execution route.",
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
    unsupported("UNSUPPORTED_NATIVE_ENCODING");
  }

  const preset = plan.terminal.preset;

  for (const [operationIndex, transformation] of plan.transformations.entries()) {
    if (transformation.type === "trim" || transformation.type === "resize") continue;

    if (transformation.type !== "convert" && transformation.type !== "compress") {
      throw createMavioError(
        "UNSUPPORTED_CAPABILITY",
        "This native execution route does not support the transformation yet.",
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

    if (
      transformation.options.preset !== preset ||
      (transformation.type === "convert" && transformation.options.format !== "mp4")
    ) {
      unsupported("UNSUPPORTED_NATIVE_ENCODING");
    }
  }

  for (const path of [inputPath, outputPath]) {
    if (
      typeof path !== "string" ||
      path.includes("\0") ||
      !isAbsolute(path) ||
      (platform === "win32" && !/^(?:[a-z]:[\\/]|\\\\)/i.test(path))
    ) {
      throw createMavioError(
        "INVALID_OPTIONS",
        "Native command paths must be fully qualified local paths.",
        {
          stage: "preparing",
          details: { reason: "INVALID_NATIVE_COMMAND_PATH" },
        },
      );
    }
  }

  const comparable = (path: string): string =>
    platform === "win32" ? normalize(path).toLowerCase() : normalize(path);

  if (comparable(inputPath) === comparable(outputPath)) {
    throw createMavioError(
      "INVALID_OPTIONS",
      "Native processing requires a separate intermediate output file.",
      {
        stage: "preparing",
        details: { reason: "INPUT_OUTPUT_PATH_CONFLICT" },
      },
    );
  }

  const selected = validateBalancedMp4Source(source, preset);
  const video = source.metadata.streams.find(
    (stream) => stream.index === selected.videoStreamIndex,
  )!;

  const resizeFilters = plan.transformations.some((item) => item.type === "resize")
    ? buildNativeResizeFilters(validateNativeResizeSource(source), plan.transformations, inventory)
    : undefined;

  const outputDimensions = resizeFilters?.dimensions ?? video;

  for (const dimension of [outputDimensions.width, outputDimensions.height]) {
    if (
      dimension === undefined ||
      !Number.isSafeInteger(dimension) ||
      dimension <= 0 ||
      dimension % 2 !== 0
    ) {
      unsupported("UNSUPPORTED_VIDEO_DIMENSIONS");
    }
  }

  const trimRange = resolveNativeTrimRange(plan.transformations, source.metadata.durationSeconds);

  const trimFilters =
    trimRange === undefined
      ? undefined
      : buildNativeTrimFilters(
          trimRange,
          source.formatStartTimeSeconds,
          selected.audioStreamIndex !== undefined,
          inventory,
        );

  const encoding = buildNativeMp4Encoding(
    preset,
    inventory,
    selected.audioStreamIndex !== undefined,
  );

  const args = [
    "-hide_banner",
    "-v",
    "error",
    "-nostdin",
    "-n",
    ...(trimFilters?.inputArgs ?? []),
    ...NATIVE_INPUT_ARGUMENTS,
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
    ...encoding,
  );

  const videoFilters = [
    ...(trimFilters === undefined ? [] : [trimFilters.video]),
    ...(resizeFilters === undefined ? [] : [resizeFilters.video]),
  ];

  if (videoFilters.length > 0) {
    args.push("-xerror", "-vf", videoFilters.join(","));
  }

  if (trimFilters !== undefined) {
    if (trimFilters.audio !== undefined) {
      args.push("-af", trimFilters.audio);
    }

    args.push(...trimFilters.mp4OutputArgs);
  }

  args.push(outputPath);

  return Object.freeze(args);
}
