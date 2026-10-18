import assert from "node:assert/strict";
import test from "node:test";
import { planNativeMp4Resize } from "../../dist/engines/native/resize-dimensions.js";

function resize(width, height) {
  return { type: "resize", options: { width, height } };
}

test("resize fits landscape and portrait video inside the requested box", () => {
  assert.deepEqual(planNativeMp4Resize({ width: 1920, height: 1080 }, [resize(640, 640)]), [
    { width: 640, height: 360 },
  ]);

  assert.deepEqual(planNativeMp4Resize({ width: 1080, height: 1920 }, [resize(640, 640)]), [
    { width: 360, height: 640 },
  ]);
});

test("resize never upscales the source or a preceding resize", () => {
  assert.deepEqual(planNativeMp4Resize({ width: 320, height: 180 }, [resize(1280, 720)]), [
    { width: 320, height: 180 },
  ]);

  assert.deepEqual(
    planNativeMp4Resize({ width: 1920, height: 1080 }, [resize(640, 360), resize(1280, 720)]),
    [
      { width: 640, height: 360 },
      { width: 640, height: 360 },
    ],
  );
});

test("resize rounds down for alignment without exceeding the box", () => {
  assert.deepEqual(planNativeMp4Resize({ width: 321, height: 181 }, [resize(321, 181)]), [
    { width: 320, height: 180 },
  ]);

  assert.deepEqual(planNativeMp4Resize({ width: 320, height: 180 }, [resize(101, 101)]), [
    { width: 100, height: 56 },
  ]);
});

test("resize rejects malformed or unrepresentably small output dimensions", () => {
  for (const operation of [
    resize(0, 100),
    resize(-1, 100),
    resize(1.5, 100),
    resize(Infinity, 100),
    resize(1, 100),
    resize(100, 1),
  ]) {
    assert.throws(
      () =>
        planNativeMp4Resize({ width: 320, height: 180 }, [
          { type: "trim", options: { start: 0, end: 1 } },
          operation,
        ]),
      (error) => {
        assert.equal(error.code, "INVALID_OPTIONS");
        assert.equal(error.operation, "resize");
        assert.equal(error.details.reason, "INVALID_DIMENSIONS");
        assert.equal(error.details.operationIndex, 1);
        return true;
      },
    );
  }
});

test("resize rejects unknown or invalid source dimensions", () => {
  for (const width of [undefined, 0, -1, NaN, Infinity, 1.5]) {
    assert.throws(
      () => planNativeMp4Resize({ width, height: 180 }, [resize(160, 90)]),
      (error) => {
        assert.equal(error.code, "INVALID_MEDIA");
        assert.equal(error.details.reason, "INVALID_SOURCE_DIMENSIONS");
        return true;
      },
    );
  }
});

test("resize planning preserves inputs and returns immutable steps", () => {
  const source = { width: 320, height: 180 };
  const transformations = [
    resize(160, 90),
    { type: "compress", options: { preset: "video-balanced-v1" } },
  ];
  const before = structuredClone({ source, transformations });

  const steps = planNativeMp4Resize(source, transformations);

  assert.deepEqual({ source, transformations }, before);
  assert.deepEqual(steps, [{ width: 160, height: 90 }]);
  assert.ok(Object.isFrozen(steps));
  assert.ok(Object.isFrozen(steps[0]));
  assert.deepEqual(planNativeMp4Resize(source, []), []);
});
