import assert from "node:assert/strict";
import test from "node:test";
import { validateBrowserThumbnailOutput } from "../../dist/engines/browser/thumbnail-output.js";

function fixture(preset = "jpeg-balanced-v1") {
  const jpeg = preset === "jpeg-balanced-v1";
  let bytes;

  if (jpeg) {
    // Structural fixture, not a complete decodable JPEG.
    bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
  } else {
    // Synthetic chunks exercise validation, not decoding or CRC checks.
    bytes = new Uint8Array(58);
    const view = new DataView(bytes.buffer);

    const text = (offset, value) => {
      bytes.set(new TextEncoder().encode(value), offset);
    };

    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);

    view.setUint32(8, 13, false);
    text(12, "IHDR");
    view.setUint32(16, 320, false);
    view.setUint32(20, 180, false);
    bytes[24] = 8;
    bytes[25] = 2;

    view.setUint32(33, 1, false);
    text(37, "IDAT");
    bytes[41] = 1;

    view.setUint32(46, 0, false);
    text(50, "IEND");
  }

  return {
    bytes,
    expected: { preset, width: 320, height: 180 },
    output: {
      metadata: {
        sizeBytes: bytes.length,
        streams: [
          {
            index: 0,
            kind: "video",
            codec: jpeg ? "mjpeg" : "png",
            width: 320,
            height: 180,
          },
        ],
      },
      streams: [
        {
          index: 0,
          pixelFormat: jpeg ? "yuvj420p" : "rgb24",
          defaultOrientation: true,
          sampleAspectRatio: "1:1",
        },
      ],
    },
  };
}

function validate(value) {
  validateBrowserThumbnailOutput(
    value.output,
    value.expected,
    value.bytes,
    "browser-thumbnail-output-test",
  );
}

function rejects(value, reason) {
  assert.throws(() => validate(value), {
    code: "EXECUTION_FAILED",
    stage: "finalizing",
    operation: "thumbnail",
    jobId: "browser-thumbnail-output-test",
    details: { reason, preset: value.expected.preset },
  });
}

test("browser thumbnail validation accepts both structural profiles without mutation", () => {
  for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
    const value = fixture(preset);
    const before = structuredClone(value);

    validate(value);

    assert.deepEqual(value, before);
  }
});

test("browser thumbnail validation preserves codec and dimension checks", () => {
  for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
    const codec = fixture(preset);
    codec.output.metadata.streams[0].codec = "h264";
    rejects(codec, "OUTPUT_IMAGE_CODEC_MISMATCH");

    const dimensions = fixture(preset);
    dimensions.output.metadata.streams[0].width = 160;
    rejects(dimensions, "OUTPUT_DIMENSIONS_MISMATCH");
  }
});

test("browser thumbnail byte size must match the probe metadata", () => {
  for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
    const value = fixture(preset);
    value.output.metadata.sizeBytes += 1;

    rejects(value, "OUTPUT_BYTE_SIZE_MISMATCH");
  }
});

test("browser JPEG validation requires opening and closing markers", () => {
  for (const index of [0, 1, 2, 6, 7]) {
    const value = fixture();
    value.bytes[index] = 0;

    rejects(value, "INVALID_JPEG_SIGNATURE");
  }

  const truncated = fixture();
  truncated.bytes = truncated.bytes.subarray(0, 4);
  truncated.output.metadata.sizeBytes = 4;

  rejects(truncated, "INVALID_JPEG_SIGNATURE");
});

test("browser PNG headers must match planned dimensions and RGB24 encoding", () => {
  for (const offset of [19, 23, 24, 25, 26, 27, 28]) {
    const value = fixture("png-lossless-v1");
    value.bytes[offset] ^= 1;

    rejects(value, "OUTPUT_IMAGE_HEADER_MISMATCH");
  }
});

test("browser PNG validation rejects bad signatures and incomplete chunk structures", () => {
  const signature = fixture("png-lossless-v1");
  signature.bytes[0] = 0;
  rejects(signature, "INVALID_PNG_SIGNATURE");

  const oversized = fixture("png-lossless-v1");
  new DataView(oversized.bytes.buffer).setUint32(33, 9999, false);
  rejects(oversized, "INVALID_PNG_STRUCTURE");

  const missingData = fixture("png-lossless-v1");
  missingData.bytes.set(new TextEncoder().encode("tEXt"), 37);
  rejects(missingData, "INVALID_PNG_STRUCTURE");

  const missingEnd = fixture("png-lossless-v1");
  missingEnd.bytes.set(new TextEncoder().encode("tEXt"), 50);
  rejects(missingEnd, "INVALID_PNG_STRUCTURE");
});

test("browser PNG validation respects offset byte views", () => {
  const value = fixture("png-lossless-v1");
  const backing = new Uint8Array(value.bytes.length + 10);

  backing.set(value.bytes, 5);
  value.bytes = backing.subarray(5, 5 + value.bytes.length);

  validate(value);
});

test("browser thumbnail validation rejects extra streams and conflicting geometry", () => {
  const streams = fixture();

  streams.output.metadata.streams.push({
    index: 1,
    kind: "audio",
    codec: "aac",
  });

  rejects(streams, "OUTPUT_STREAMS_MISMATCH");

  const geometry = fixture("png-lossless-v1");
  geometry.output.streams[0].sampleAspectRatio = "2:1";

  rejects(geometry, "OUTPUT_IMAGE_GEOMETRY_MISMATCH");
});
