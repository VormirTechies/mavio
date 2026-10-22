import assert from "node:assert/strict";
import test from "node:test";
import { validateBrowserMp4Output } from "../../dist/engines/browser/mp4-output.js";

function fixture() {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 24, false);
  bytes.set(new TextEncoder().encode("ftyp"), 4);
  bytes.set(new TextEncoder().encode("isom"), 8);
  bytes.set(new TextEncoder().encode("isomiso2"), 16);

  return {
    bytes,
    expected: {
      width: 320,
      height: 180,
      preset: "video-balanced-v1",
      audio: {
        sampleRate: 48000,
        channels: 2,
        channelLayout: "stereo",
      },
    },
    output: {
      metadata: {
        container: "mov,mp4,m4a,3gp,3g2,mj2",
        durationSeconds: 1,
        sizeBytes: 64,
        streams: [
          {
            index: 0,
            kind: "video",
            codec: "h264",
            width: 320,
            height: 180,
          },
          {
            index: 1,
            kind: "audio",
            codec: "aac",
            sampleRate: 48000,
            channels: 2,
          },
        ],
      },
      streams: [
        {
          index: 0,
          attachedPicture: false,
          pixelFormat: "yuv420p",
          colorTransfer: "bt709",
          colorPrimaries: "bt709",
          colorSpace: "bt709",
          colorRange: "tv",
          sampleAspectRatio: "1:1",
          defaultOrientation: true,
        },
        {
          index: 1,
          channelLayout: "stereo",
        },
      ],
    },
  };
}

function validate(value) {
  validateBrowserMp4Output(value.output, value.expected, value.bytes, "browser-output-test");
}

test("browser MP4 output accepts both preset expectations and bounded byte views", () => {
  for (const preset of ["video-balanced-v1", "video-small-v1"]) {
    const value = fixture();
    value.expected.preset = preset;

    const backing = new Uint8Array(80);
    backing.set(value.bytes, 8);
    value.bytes = backing.subarray(8, 72);

    assert.doesNotThrow(() => validate(value));
  }
});

test("browser MP4 output always requires normalized geometry", () => {
  for (const modify of [
    (value) => {
      value.output.streams[0].sampleAspectRatio = "4:3";
    },
    (value) => {
      value.output.streams[0].defaultOrientation = false;
    },
    (value) => {
      value.output.metadata.streams[0].width = 640;
    },
  ]) {
    const value = fixture();
    modify(value);

    assert.throws(() => validate(value), {
      code: "EXECUTION_FAILED",
      stage: "finalizing",
      jobId: "browser-output-test",
    });
  }
});

test("browser MP4 output bytes must match the probed file size", () => {
  const value = fixture();
  value.output.metadata.sizeBytes = 65;

  assert.throws(() => validate(value), {
    code: "EXECUTION_FAILED",
    details: {
      reason: "OUTPUT_BYTE_SIZE_MISMATCH",
      preset: "video-balanced-v1",
    },
  });
});

test("browser MP4 output rejects malformed headers and unsupported brands", () => {
  for (const modify of [
    (value) => {
      value.bytes[4] = 0;
    },
    (value) => {
      new DataView(value.bytes.buffer).setUint32(0, 12, false);
    },
    (value) => {
      new DataView(value.bytes.buffer).setUint32(0, 128, false);
    },
    (value) => {
      new DataView(value.bytes.buffer).setUint32(0, 19, false);
    },
    (value) => {
      value.bytes.set(new TextEncoder().encode("qt  "), 8);
    },
    (value) => {
      value.bytes = value.bytes.subarray(0, 8);
      value.output.metadata.sizeBytes = 8;
    },
  ]) {
    const value = fixture();
    modify(value);

    assert.throws(() => validate(value), {
      code: "EXECUTION_FAILED",
      stage: "finalizing",
    });
  }
});
