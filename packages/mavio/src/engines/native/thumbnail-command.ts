import { NATIVE_INPUT_ARGUMENTS } from "./input-policy.js";
import { isAbsolute, normalize } from "node:path";
import { platform } from "node:process";
import type { ProcessingPlan } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import type { NativeInventory } from "./inventory.js";
import type { NativeProbeDetails } from "./probe-details.js";
import { buildNativeThumbnailEncoding } from "./thumbnail-encoding.js";
import { buildNativeThumbnailFilters } from "./thumbnail-filters.js";
import { validateNativeThumbnailSource } from "./thumbnail-source.js";
import { resolveNativeThumbnailTime } from "./thumbnail-time.js";
import { buildNativeThumbnailResize } from "./thumbnail-resize.js";

interface CommandOptions {
  plan: ProcessingPlan;
  source: NativeProbeDetails;
  inventory: NativeInventory;
  inputPath: string;
  /** A new adapter-owned intermediate file. */
  outputPath: string;
}

export function buildNativeThumbnailCommand({
  plan,
  source,
  inventory,
  inputPath,
  outputPath,
}: CommandOptions): readonly string[] {
  function invalid(reason: string): never {
    throw createMavioError("INVALID_OPTIONS", "Invalid native thumbnail command options.", {
      stage: "preparing",
      operation: "thumbnail",
      details: { reason },
    });
  }

  const terminal = plan.terminal;

  if (
    terminal.type !== "thumbnail" ||
    (terminal.preset !== "jpeg-balanced-v1" && terminal.preset !== "png-lossless-v1")
  ) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "This route requires a supported thumbnail preset.",
      {
        stage: "preparing",
        operation: "thumbnail",
        details: { reason: "UNSUPPORTED_NATIVE_ENCODING" },
      },
    );
  }

  const preset = terminal.preset;
  const jpeg = preset === "jpeg-balanced-v1";

  if (terminal.format !== (jpeg ? "jpeg" : "png")) {
    invalid("TERMINAL_FORMAT_MISMATCH");
  }

  for (const transformation of plan.transformations) {
    if (transformation.type !== "trim" && transformation.type !== "resize") {
      invalid("INVALID_THUMBNAIL_TRANSFORMATION");
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

  const selected = validateNativeThumbnailSource(source);

  const resize = buildNativeThumbnailResize(selected, plan.transformations, preset, inventory);

  const time = resolveNativeThumbnailTime(
    plan.transformations,
    source.metadata.durationSeconds,
    terminal.at,
  );
  const filters = buildNativeThumbnailFilters(time, source.formatStartTimeSeconds, inventory);
  const encoding = buildNativeThumbnailEncoding(preset, inventory);

  for (const filter of ["scale", "format"]) {
    if (!inventory.filters.includes(filter)) {
      throw createMavioError(
        "UNSUPPORTED_CAPABILITY",
        `The installed FFmpeg build lacks ${filter}.`,
        {
          stage: "preparing",
          operation: "thumbnail",
          details: { reason: "MISSING_FILTER", filter },
        },
      );
    }
  }

  // Convert the validated source into the preset's image pixel representation
  // before applying the requested sequential resizes.
  const conversion = jpeg
    ? "scale=in_color_matrix=bt709:out_color_matrix=bt601:in_range=tv:out_range=pc,format=yuvj420p"
    : "scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24";

  return Object.freeze([
    "-hide_banner",
    "-v",
    "error",
    "-nostdin",
    "-n",
    "-xerror",
    ...filters.inputArgs,
    "-noautorotate",
    ...NATIVE_INPUT_ARGUMENTS,
    "-i",
    inputPath,
    "-map",
    `0:${selected.videoStreamIndex}`,
    "-an",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-map_metadata:s",
    "-1",
    "-map_chapters",
    "-1",
    "-vf",
    [filters.video, conversion, resize.video].filter(Boolean).join(","),
    "-fps_mode:v",
    "passthrough",
    "-color_range",
    "pc",
    "-colorspace",
    jpeg ? "smpte170m" : "rgb",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    ...encoding,
    outputPath,
  ]);
}
