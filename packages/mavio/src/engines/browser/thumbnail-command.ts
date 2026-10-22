import type { ProcessingPlan } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import { buildThumbnailResize } from "../shared/thumbnail-resize.js";
import type { BrowserInventory } from "./inventory.js";
import type { BrowserProbeDetails } from "./probe-details.js";
import { buildBrowserThumbnailEncoding } from "./thumbnail-encoding.js";
import { buildBrowserThumbnailPlan } from "./thumbnail-plan.js";

interface CommandOptions {
  plan: ProcessingPlan;
  source: BrowserProbeDetails;
  inventory: BrowserInventory;
  inputPath: string;
  outputPath: string;
}

export function buildBrowserThumbnailCommand({
  plan,
  source,
  inventory,
  inputPath,
  outputPath,
}: CommandOptions): readonly string[] {
  function invalid(reason: string): never {
    throw createMavioError("INVALID_OPTIONS", "Invalid browser thumbnail command options.", {
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
      "This route requires a supported browser thumbnail preset.",
      {
        stage: "preparing",
        operation: "thumbnail",
        details: { reason: "UNSUPPORTED_BROWSER_ENCODING" },
      },
    );
  }

  const preset = terminal.preset;
  const jpeg = preset === "jpeg-balanced-v1";
  const format = jpeg ? "jpeg" : "png";

  if (terminal.format !== format) {
    invalid("TERMINAL_FORMAT_MISMATCH");
  }

  if (
    !["bytes", "blob"].includes(plan.input.kind) ||
    !["bytes", "blob"].includes(plan.output.kind)
  ) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "Browser thumbnails require byte or Blob input and output.",
      {
        stage: "preparing",
        operation: "thumbnail",
        details: { reason: "UNSUPPORTED_BROWSER_IO" },
      },
    );
  }

  if (
    typeof inputPath !== "string" ||
    !/^\/mavio-[A-Za-z0-9-]+\/input\.bin$/.test(inputPath) ||
    outputPath !== `${inputPath.slice(0, -"input.bin".length)}output.${format}`
  ) {
    invalid("INVALID_BROWSER_COMMAND_PATH");
  }

  const selection = buildBrowserThumbnailPlan(source, plan.transformations, terminal.at, inventory);

  const resize = buildThumbnailResize(selection.source, plan.transformations, preset, inventory);

  const encoding = buildBrowserThumbnailEncoding(preset, inventory);

  for (const filter of ["scale", "format"]) {
    if (!inventory.filters.includes(filter)) {
      throw createMavioError("UNSUPPORTED_CAPABILITY", `The browser core lacks ${filter}.`, {
        stage: "preparing",
        operation: "thumbnail",
        details: { reason: "MISSING_FILTER", filter },
      });
    }
  }

  const conversion = jpeg
    ? "scale=in_color_matrix=bt709:out_color_matrix=bt601:in_range=tv:out_range=pc,format=yuvj420p"
    : "scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24";

  return Object.freeze([
    "-hide_banner",
    "-v",
    "error",
    "-xerror",
    ...selection.inputArgs,
    "-noautorotate",
    "-filter_threads",
    "1",
    "-protocol_whitelist",
    "file",
    "-i",
    inputPath,
    "-map",
    `0:${selection.source.videoStreamIndex}`,
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
    [selection.video, conversion, resize.video].filter(Boolean).join(","),
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
