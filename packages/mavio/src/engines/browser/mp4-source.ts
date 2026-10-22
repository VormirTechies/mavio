import { createMavioError } from "../../core/errors.js";
import { validateBalancedMp4Source } from "../shared/mp4-source.js";
import type { BrowserInventory } from "./inventory.js";
import type { BrowserMp4Preset } from "./mp4-encoding.js";
import type { BrowserProbeDetails } from "./probe-details.js";

export function validateBrowserMp4Source(
  source: BrowserProbeDetails,
  inventory: BrowserInventory,
  preset: BrowserMp4Preset,
) {
  const selected = validateBalancedMp4Source(source, preset);

  function unsupported(reason: string, streamIndex: number): never {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The source is outside the current browser MP4 profile.",
      {
        stage: "preparing",
        details: { reason, streamIndex, preset },
      },
    );
  }

  const video = source.metadata.streams.find(
    (stream) => stream.index === selected.videoStreamIndex,
  )!;

  const details = source.streams.find((stream) => stream.index === selected.videoStreamIndex)!;

  if (
    details.defaultOrientation !== true ||
    (video.rotationDegrees !== undefined && video.rotationDegrees !== 0)
  ) {
    unsupported("UNSUPPORTED_VIDEO_ORIENTATION", video.index);
  }

  if (details.sampleAspectRatio !== "1:1") {
    unsupported("UNSUPPORTED_SAMPLE_ASPECT_RATIO", video.index);
  }

  for (const dimension of [video.width, video.height]) {
    if (
      dimension === undefined ||
      !Number.isSafeInteger(dimension) ||
      dimension <= 0 ||
      dimension % 2 !== 0
    ) {
      unsupported("UNSUPPORTED_VIDEO_DIMENSIONS", video.index);
    }
  }

  const indexes = [
    selected.videoStreamIndex,
    ...(selected.audioStreamIndex === undefined ? [] : [selected.audioStreamIndex]),
  ];

  for (const index of indexes) {
    const stream = source.metadata.streams.find((candidate) => candidate.index === index)!;

    if (stream.codec === undefined || !inventory.decoders.includes(stream.codec)) {
      unsupported("MISSING_SOURCE_DECODER", index);
    }
  }

  return selected;
}
