import type { MediaMetadata as MavioMediaMetadata } from "../../contracts.js";
import { parseNativeProbeMetadata } from "./probe-metadata.js";

export interface NativeStreamDetails {
  readonly index: number;
  readonly pixelFormat?: string;
  readonly colorTransfer?: string;
  readonly colorPrimaries?: string;
  readonly colorSpace?: string;
  readonly colorRange?: string;
  readonly channelLayout?: string;
  readonly sampleAspectRatio?: string;
  readonly startTimeSeconds?: number;
  readonly attachedPicture?: boolean;
  readonly defaultOrientation?: boolean;
}

export interface NativeProbeDetails {
  readonly metadata: MavioMediaMetadata;
  readonly formatStartTimeSeconds?: number;
  readonly streams: readonly NativeStreamDetails[];
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const text = value.trim();

  if (text === "" || ["unknown", "unspecified", "n/a"].includes(text.toLowerCase())) {
    return undefined;
  }

  return text;
}

function optionalTime(value: unknown): number | undefined {
  if (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    return undefined;
  }

  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }

  const result = Number(value);

  return Number.isFinite(result) ? result : undefined;
}

function attachedPicture(value: unknown): boolean | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const flag = (value as Record<string, unknown>).attached_pic;

  if (flag === 0) return false;
  if (flag === 1) return true;

  return undefined;
}

function hasDefaultOrientation(stream: Record<string, unknown>): boolean {
  const tags = stream.tags;

  if (tags !== undefined) {
    if (tags === null || typeof tags !== "object" || Array.isArray(tags)) {
      return false;
    }

    // Even an explicit zero rotation needs separate orientation handling.
    if ("rotate" in tags) return false;
  }

  const sideData = stream.side_data_list;

  if (sideData === undefined) return true;
  if (!Array.isArray(sideData)) return false;

  return sideData.every((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }

    const record = entry as Record<string, unknown>;

    return (
      typeof record.side_data_type === "string" &&
      record.side_data_type !== "Display Matrix" &&
      !("rotation" in record)
    );
  });
}

export function parseNativeProbeDetails(text: string, jobId?: string): NativeProbeDetails {
  // Validate the response using the existing public metadata parser first.
  const metadata = parseNativeProbeMetadata(text, jobId);

  const raw = JSON.parse(text) as {
    format?: Record<string, unknown>;
    streams: Record<string, unknown>[];
  };

  const streams = raw.streams.map((stream, position): NativeStreamDetails =>
    Object.freeze({
      index: metadata.streams[position]!.index,
      pixelFormat: optionalText(stream.pix_fmt),
      colorTransfer: optionalText(stream.color_transfer),
      colorPrimaries: optionalText(stream.color_primaries),
      colorSpace: optionalText(stream.color_space),
      colorRange: optionalText(stream.color_range),
      channelLayout: optionalText(stream.channel_layout),
      sampleAspectRatio: optionalText(stream.sample_aspect_ratio),
      startTimeSeconds: optionalTime(stream.start_time),
      attachedPicture: attachedPicture(stream.disposition),
      defaultOrientation: hasDefaultOrientation(stream),
    }),
  );

  return Object.freeze({
    metadata,
    formatStartTimeSeconds: optionalTime(raw.format?.start_time),
    streams: Object.freeze(streams),
  });
}
