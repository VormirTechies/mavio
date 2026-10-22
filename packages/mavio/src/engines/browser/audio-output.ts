import { createMavioError } from "../../core/errors.js";
import { validateAudioOutput, type AudioOutputExpectation } from "../shared/audio-output.js";
import type { BrowserProbeDetails } from "./probe-details.js";

export type BrowserAudioOutputExpectation = AudioOutputExpectation;

/**
 * Validates probe metadata and the bounded MP3/PCM WAV output headers.
 * Full decoding remains a separate real-media acceptance check.
 */
export function validateBrowserAudioOutput(
  output: BrowserProbeDetails,
  expected: BrowserAudioOutputExpectation,
  bytes: Uint8Array,
  jobId?: string,
): void {
  validateAudioOutput(output, expected, jobId);

  function invalid(reason: string): never {
    throw createMavioError(
      "EXECUTION_FAILED",
      "The encoded browser audio failed byte validation.",
      {
        stage: "finalizing",
        jobId,
        details: { reason, preset: expected.preset },
      },
    );
  }

  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== output.metadata.sizeBytes) {
    invalid("OUTPUT_BYTE_SIZE_MISMATCH");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  function fourCC(offset: number): string {
    return String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    );
  }

  if (expected.preset === "audio-balanced-v1") {
    let offset = 0;

    if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      if (bytes.length < 10) {
        invalid("INVALID_MP3_SIGNATURE");
      }

      const version = bytes[3];
      const flags = bytes[5];

      // This writer profile accepts ID3v2.3/v2.4 without a footer.
      if (
        (version !== 3 && version !== 4) ||
        bytes[4] === 0xff ||
        (flags & (version === 3 ? 0x1f : 0x0f)) !== 0 ||
        (version === 4 && (flags & 0x10) !== 0)
      ) {
        invalid("INVALID_MP3_SIGNATURE");
      }

      let tagSize = 0;

      for (let index = 6; index < 10; index += 1) {
        if (bytes[index] >= 0x80) {
          invalid("INVALID_MP3_SIGNATURE");
        }

        tagSize = tagSize * 128 + bytes[index];
      }

      offset = 10 + tagSize;
    }

    if (
      bytes.length - offset < 4 ||
      bytes[offset] !== 0xff ||
      (bytes[offset + 1] & 0xfe) !== 0xfa
    ) {
      invalid("INVALID_MP3_SIGNATURE");
    }

    const bitrateIndex = bytes[offset + 2] >>> 4;
    const rateIndex = (bytes[offset + 2] >>> 2) & 3;
    const padding = (bytes[offset + 2] >>> 1) & 1;

    const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const rates = [44100, 48000, 32000];

    if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      invalid("INVALID_MP3_SIGNATURE");
    }

    const sampleRate = rates[rateIndex];
    const channels = bytes[offset + 3] >>> 6 === 3 ? 1 : 2;

    if (sampleRate !== expected.sampleRate || channels !== expected.channels) {
      invalid("OUTPUT_AUDIO_HEADER_MISMATCH");
    }

    // The leading Xing/Info frame may use a different bitrate.
    const frameSize = Math.floor((144000 * bitrates[bitrateIndex]) / sampleRate) + padding;

    if (frameSize > bytes.length - offset) {
      invalid("INVALID_MP3_SIGNATURE");
    }

    return;
  }

  if (bytes.length < 12 || fourCC(0) !== "RIFF" || fourCC(8) !== "WAVE") {
    invalid("INVALID_WAV_SIGNATURE");
  }

  if (view.getUint32(4, true) !== bytes.length - 8) {
    invalid("INVALID_WAV_STRUCTURE");
  }

  let offset = 12;
  let foundFormat = false;
  let foundData = false;

  const blockAlign = expected.channels * 2;

  while (offset < bytes.length) {
    if (bytes.length - offset < 8) {
      invalid("INVALID_WAV_STRUCTURE");
    }

    const kind = fourCC(offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    const next = end + (size & 1);

    if (end > bytes.length || next > bytes.length) {
      invalid("INVALID_WAV_STRUCTURE");
    }

    if (kind === "fmt ") {
      if (foundFormat || size < 16) {
        invalid("INVALID_WAV_STRUCTURE");
      }

      foundFormat = true;

      if (
        view.getUint16(start, true) !== 1 ||
        view.getUint16(start + 2, true) !== expected.channels ||
        view.getUint32(start + 4, true) !== expected.sampleRate ||
        view.getUint32(start + 8, true) !== expected.sampleRate * blockAlign ||
        view.getUint16(start + 12, true) !== blockAlign ||
        view.getUint16(start + 14, true) !== 16
      ) {
        invalid("OUTPUT_AUDIO_HEADER_MISMATCH");
      }
    }

    if (kind === "data") {
      if (foundData || size === 0 || size % blockAlign !== 0) {
        invalid("INVALID_WAV_STRUCTURE");
      }

      foundData = true;
    }

    offset = next;
  }

  if (!foundFormat || !foundData) {
    invalid("INVALID_WAV_STRUCTURE");
  }
}
