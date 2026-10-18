import type { MediaMetadata as MavioMediaMetadata } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";

export interface NativeAudioStream {
  readonly audioStreamIndex: number;
}

/** Accepts source metadata already validated by the core. */
export function selectNativeAudioStream(
  source: MavioMediaMetadata,
  streamIndex?: number,
): NativeAudioStream {
  function invalidIndex(): never {
    throw createMavioError(
      "INVALID_OPTIONS",
      "The requested stream index must identify a source audio stream.",
      {
        stage: "preparing",
        details: { reason: "INVALID_STREAM_INDEX" },
      },
    );
  }

  if (streamIndex !== undefined && (!Number.isSafeInteger(streamIndex) || streamIndex < 0)) {
    invalidIndex();
  }

  const audio =
    streamIndex === undefined
      ? source.streams.find((stream) => stream.kind === "audio")
      : source.streams.find((stream) => stream.index === streamIndex);

  if (streamIndex !== undefined && audio?.kind !== "audio") {
    invalidIndex();
  }

  if (audio === undefined) {
    throw createMavioError("INVALID_MEDIA", "The audio preset requires an audio stream.", {
      stage: "preparing",
      details: { reason: "MISSING_AUDIO" },
    });
  }

  return Object.freeze({ audioStreamIndex: audio.index });
}
