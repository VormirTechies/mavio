import assert from "node:assert/strict";
import test from "node:test";
import {
  appendTransformation as append,
  EMPTY_TRANSFORMATIONS as empty,
} from "../../dist/core/composition.js";

function rejects(chain, type, options, reason) {
  assert.throws(
    () => append(chain, type, options),
    (error) => {
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.stage, "queued");
      assert.equal(error.jobId, undefined);
      assert.equal(error.operation, type);
      assert.equal(error.details.reason, reason);
      assert.equal(error.details.operationIndex, chain.length);
      return true;
    },
  );
}

test("branches preserve their parent and remain independent", () => {
  const parent = append(empty, "trim", { start: 0, end: 10 });
  const small = append(parent, "resize", { width: 320, height: 180 });
  const large = append(parent, "resize", { width: 1280, height: 720 });

  assert.equal(empty.length, 0);
  assert.equal(parent.length, 1);
  assert.equal(small.length, 2);
  assert.equal(large.length, 2);
  assert.notEqual(small, large);
  assert.equal(small[1].options.width, 320);
  assert.equal(large[1].options.width, 1280);

  for (const chain of [empty, parent, small, large]) {
    assert.ok(Object.isFrozen(chain));
  }
});

test("repeated trims and resizes preserve insertion order", () => {
  let chain = append(empty, "trim", { start: 0, end: 10 });
  chain = append(chain, "resize", { width: 1280, height: 720 });
  chain = append(chain, "trim", { start: 1, end: 3 });
  chain = append(chain, "resize", { width: 640, height: 360 });

  assert.deepEqual(
    chain.map((item) => item.type),
    ["trim", "resize", "trim", "resize"],
  );
});

test("duplicate encoding declarations and audio extraction are rejected", () => {
  const cases = [
    ["convert", { format: "mp4", preset: "video-balanced-v1" }],
    ["compress", { preset: "video-small-v1" }],
    ["extractAudio", {}],
  ];

  for (const [type, options] of cases) {
    const chain = append(empty, type, options);
    rejects(chain, type, options, "DUPLICATE_OPERATION");
    assert.equal(chain.length, 1);
  }
});

test("convert and compress must agree in either order", () => {
  const convert = { format: "mp4", preset: "video-balanced-v1" };

  const converted = append(empty, "convert", convert);
  assert.equal(append(converted, "compress", { preset: "video-balanced-v1" }).length, 2);
  rejects(converted, "compress", { preset: "video-small-v1" }, "PRESET_CONFLICT");

  const compressed = append(empty, "compress", {
    preset: "video-balanced-v1",
  });
  assert.equal(append(compressed, "convert", convert).length, 2);
  rejects(compressed, "convert", { format: "mp4", preset: "video-small-v1" }, "PRESET_CONFLICT");
});

test("resize before extraction is allowed but resize afterward is rejected", () => {
  const resized = append(empty, "resize", { width: 640, height: 360 });
  const extracted = append(resized, "extractAudio");

  assert.equal(extracted.length, 2);
  rejects(extracted, "resize", { width: 320, height: 180 }, "STREAM_PLAN_MISMATCH");
});

test("video encoding conflicts with extraction in either order", () => {
  const extracted = append(empty, "extractAudio");

  for (const [type, options] of [
    ["convert", { format: "mp4", preset: "video-balanced-v1" }],
    ["compress", { preset: "video-small-v1" }],
  ]) {
    rejects(extracted, type, options, "STREAM_PLAN_MISMATCH");

    const encoded = append(empty, type, options);
    rejects(encoded, "extractAudio", undefined, "STREAM_PLAN_MISMATCH");
  }
});

test("audio encoding is compatible with extraction in either order", () => {
  const options = { format: "wav", preset: "audio-pcm-v1" };
  const extracted = append(empty, "extractAudio", { streamIndex: 2 });
  const encoded = append(empty, "convert", options);

  assert.equal(append(extracted, "convert", options).length, 2);
  assert.equal(append(encoded, "extractAudio", { streamIndex: 2 }).length, 2);
});
