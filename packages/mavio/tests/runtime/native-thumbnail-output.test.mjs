import assert from "node:assert/strict";
import test from "node:test";
import { validateNativeThumbnailOutput } from "../../dist/engines/native/thumbnail-output.js";

const presets = ["jpeg-balanced-v1", "png-lossless-v1"];

function fixture(preset = "jpeg-balanced-v1") {
  const jpeg = preset === "jpeg-balanced-v1";

  return {
    expected: { preset, width: 320, height: 180 },
    output: {
      metadata: {
        sizeBytes: 4096,
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

function rejects(output, expected, reason) {
  assert.throws(() => validateNativeThumbnailOutput(output, expected, "thumbnail-output-test"), {
    code: "EXECUTION_FAILED",
    stage: "finalizing",
    operation: "thumbnail",
    jobId: "thumbnail-output-test",
    details: { reason, preset: expected.preset },
  });
}

test("thumbnail output accepts both presets without requiring duration", () => {
  for (const preset of presets) {
    const { output, expected } = fixture(preset);
    const before = structuredClone(output);

    validateNativeThumbnailOutput(output, expected);

    assert.deepEqual(output, before);

    delete output.streams[0].sampleAspectRatio;
    validateNativeThumbnailOutput(output, expected);
  }
});

test("thumbnail output requires the exact image codec", () => {
  for (const preset of presets) {
    for (const codec of ["h264", undefined, preset === "jpeg-balanced-v1" ? "png" : "mjpeg"]) {
      const { output, expected } = fixture(preset);
      output.metadata.streams[0].codec = codec;

      rejects(output, expected, "OUTPUT_IMAGE_CODEC_MISMATCH");
    }
  }
});

test("thumbnail output requires exactly one video stream", () => {
  for (const preset of presets) {
    for (const mode of ["empty", "audio", "extra-video", "extra-audio"]) {
      const { output, expected } = fixture(preset);

      if (mode === "empty") {
        output.metadata.streams = [];
      } else if (mode === "audio") {
        output.metadata.streams[0].kind = "audio";
      } else {
        output.metadata.streams.push({
          index: 1,
          kind: mode === "extra-video" ? "video" : "audio",
        });
      }

      rejects(output, expected, "OUTPUT_STREAMS_MISMATCH");
    }
  }
});

test("thumbnail output must match planned dimensions", () => {
  for (const preset of presets) {
    for (const field of ["width", "height"]) {
      for (const value of [undefined, 0, 1, 640]) {
        const { output, expected } = fixture(preset);
        output.metadata.streams[0][field] = value;

        rejects(output, expected, "OUTPUT_DIMENSIONS_MISMATCH");
      }
    }
  }
});

test("thumbnail output requires a positive safe integer byte size", () => {
  for (const size of [undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const { output, expected } = fixture();
    output.metadata.sizeBytes = size;

    rejects(output, expected, "INVALID_OUTPUT_SIZE");
  }
});

test("thumbnail output requires matching technical details and pixel format", () => {
  for (const preset of presets) {
    for (const mode of ["missing", "extra", "index", "pixel-format"]) {
      const { output, expected } = fixture(preset);

      if (mode === "missing") {
        output.streams = [];
      } else if (mode === "extra") {
        output.streams.push({ index: 1 });
      } else if (mode === "index") {
        output.streams[0].index = 7;
      } else {
        output.streams[0].pixelFormat = "rgba";
      }

      rejects(output, expected, "OUTPUT_IMAGE_PROFILE_MISMATCH");
    }
  }
});

test("thumbnail output rejects conflicting or unverified geometry", () => {
  for (const preset of presets) {
    for (const mode of ["rotation", "orientation", "unknown", "aspect"]) {
      const { output, expected } = fixture(preset);

      if (mode === "rotation") {
        output.metadata.streams[0].rotationDegrees = 90;
      } else if (mode === "orientation") {
        output.streams[0].defaultOrientation = false;
      } else if (mode === "unknown") {
        delete output.streams[0].defaultOrientation;
      } else {
        output.streams[0].sampleAspectRatio = "4:3";
      }

      rejects(output, expected, "OUTPUT_IMAGE_GEOMETRY_MISMATCH");
    }
  }
});
