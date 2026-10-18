import assert from "node:assert/strict";
import test from "node:test";
import { parseNativeProbeDetails } from "../../dist/engines/native/probe-details.js";
import { validateNativeResizeSource } from "../../dist/engines/native/resize-source.js";

function source(overrides = {}) {
  return parseNativeProbeDetails(
    JSON.stringify({
      streams: [
        {
          index: 3,
          codec_type: "video",
          width: 320,
          height: 180,
          sample_aspect_ratio: "1:1",
          ...overrides,
        },
      ],
    }),
  );
}

test("resize accepts explicit square pixels with default orientation", () => {
  const dimensions = validateNativeResizeSource(source());

  assert.deepEqual(dimensions, { width: 320, height: 180 });
  assert.ok(Object.isFrozen(dimensions));
});

test("resize rejects missing and unsupported sample aspect ratios", () => {
  for (const sample_aspect_ratio of [undefined, "N/A", "0:1", "4:3"]) {
    assert.throws(
      () => validateNativeResizeSource(source({ sample_aspect_ratio })),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
        assert.equal(error.details.reason, "UNSUPPORTED_RESIZE_SAMPLE_ASPECT_RATIO");
        return true;
      },
    );
  }
});

test("resize rejects explicit or unverified orientation", () => {
  for (const input of [
    source({ tags: { rotate: "0" } }),
    source({ tags: { rotate: "90" } }),
    source({
      side_data_list: [{ side_data_type: "Display Matrix", rotation: 0 }],
    }),
    {
      ...source(),
      streams: [{ index: 3, sampleAspectRatio: "1:1" }],
    },
  ]) {
    assert.throws(
      () => validateNativeResizeSource(input),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
        assert.equal(error.details.reason, "UNSUPPORTED_RESIZE_ORIENTATION");
        return true;
      },
    );
  }
});

test("resize rejects invalid source dimensions", () => {
  for (const width of [undefined, 0, -1]) {
    assert.throws(
      () => validateNativeResizeSource(source({ width })),
      (error) => {
        assert.equal(error.code, "INVALID_MEDIA");
        assert.equal(error.details.reason, "INVALID_SOURCE_DIMENSIONS");
        return true;
      },
    );
  }
});

test("probe details distinguish absent orientation from malformed metadata", () => {
  assert.equal(source().streams[0].defaultOrientation, true);

  for (const overrides of [
    { tags: null },
    { tags: { rotate: "invalid" } },
    { side_data_list: null },
    { side_data_list: [{}] },
    { side_data_list: [{ side_data_type: "Display Matrix" }] },
  ]) {
    assert.equal(source(overrides).streams[0].defaultOrientation, false);
  }
});

test("unrelated valid side data does not imply rotated orientation", () => {
  const input = source({
    tags: { language: "und" },
    side_data_list: [{ side_data_type: "CPB properties" }],
  });

  assert.equal(input.streams[0].defaultOrientation, true);
  assert.deepEqual(validateNativeResizeSource(input), {
    width: 320,
    height: 180,
  });
});
