import assert from "node:assert/strict";
import test from "node:test";
import {
  appendTransformation as append,
  EMPTY_TRANSFORMATIONS as empty,
} from "../../dist/core/composition.js";
import { captureExport, captureThumbnail, validateMetadata } from "../../dist/core/terminals.js";

const video = append(empty, "convert", {
  format: "mp4",
  preset: "video-balanced-v1",
});

function rejects(callback, reason) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, "INVALID_OPTIONS");
    assert.equal(error.stage, "queued");
    assert.equal(error.jobId, undefined);
    assert.equal(error.details.reason, reason);
    return true;
  });
}

test("export resolves explicit encoding and captures the output target", () => {
  const output = { kind: "path", path: "result.mp4" };
  const result = captureExport(video, { output });

  output.path = "changed.mp4";

  assert.deepEqual(result.terminal, {
    type: "export",
    format: "mp4",
    preset: "video-balanced-v1",
  });
  assert.deepEqual(result.output, { kind: "path", path: "result.mp4" });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.terminal));
  assert.ok(Object.isFrozen(result.output));

  const compressed = append(empty, "compress", { preset: "audio-pcm-v1" });
  assert.equal(
    captureExport(compressed, { format: "wav", output: { kind: "bytes" } }).terminal.format,
    "wav",
  );
});

test("export rejects missing encoding declarations and conflicts", () => {
  const output = { kind: "bytes" };

  rejects(() => captureExport(empty, { output }), "MISSING_FORMAT");
  rejects(() => captureExport(empty, { format: "mp4", output }), "MISSING_PRESET");
  rejects(() => captureExport(video, { format: "wav", output }), "FORMAT_CONFLICT");

  const compressed = append(empty, "compress", { preset: "audio-pcm-v1" });
  rejects(() => captureExport(compressed, { format: "mp3", output }), "PRESET_FORMAT_MISMATCH");
});

test("generic export rejects image output and unsupported preset pairings", () => {
  const image = append(empty, "convert", {
    format: "png",
    preset: "png-lossless-v1",
  });
  rejects(() => captureExport(image, { output: { kind: "bytes" } }), "TERMINAL_FORMAT_MISMATCH");

  const compressed = append(empty, "compress", {
    preset: "video-balanced-v1",
  });
  rejects(
    () =>
      captureExport(compressed, {
        format: "webm",
        output: { kind: "bytes" },
      }),
    "PRESET_FORMAT_MISMATCH",
  );
});

test("terminal output descriptors reject malformed targets", () => {
  for (const output of [undefined, null, []]) {
    rejects(() => captureExport(video, { output }), "INVALID_SHAPE");
  }

  rejects(() => captureExport(video, { output: { kind: "url" } }), "INVALID_OUTPUT_KIND");

  for (const path of ["", 42, "bad\0.mp4"]) {
    rejects(() => captureExport(video, { output: { kind: "path", path } }), "INVALID_OUTPUT_PATH");
  }
});

test("thumbnail accepts trims and resizes with matching image encoding", () => {
  let chain = append(empty, "trim", { start: 1, end: 3 });
  chain = append(chain, "resize", { width: 320, height: 180 });

  const options = {
    at: 0.5,
    format: "jpeg",
    preset: "jpeg-balanced-v1",
    output: { kind: "blob" },
  };
  const result = captureThumbnail(chain, options);
  options.at = 99;

  assert.equal(result.terminal.at, 0.5);
  assert.equal(result.terminal.type, "thumbnail");
  assert.ok(Object.isFrozen(result.terminal));
});

test("thumbnail rejects invalid times, encodings, and preceding operations", () => {
  const options = {
    at: 0,
    format: "png",
    preset: "png-lossless-v1",
    output: { kind: "bytes" },
  };

  for (const at of [-1, NaN, Infinity, "0"]) {
    rejects(() => captureThumbnail(empty, { ...options, at }), "INVALID_TIME");
  }

  rejects(() => captureThumbnail(empty, { ...options, format: "mp4" }), "TERMINAL_FORMAT_MISMATCH");
  rejects(
    () =>
      captureThumbnail(empty, {
        ...options,
        preset: "jpeg-balanced-v1",
      }),
    "PRESET_FORMAT_MISMATCH",
  );

  for (const chain of [
    video,
    append(empty, "compress", { preset: "video-small-v1" }),
    append(empty, "extractAudio"),
  ]) {
    rejects(() => captureThumbnail(chain, options), "INVALID_COMPOSITION");
  }
});

test("metadata accepts only an untransformed source", () => {
  assert.doesNotThrow(() => validateMetadata(empty));
  rejects(
    () => validateMetadata(append(empty, "trim", { start: 0, end: 1 })),
    "INVALID_COMPOSITION",
  );
});
