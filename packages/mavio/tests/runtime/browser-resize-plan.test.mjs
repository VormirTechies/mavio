import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserResizePlan } from "../../dist/engines/browser/resize-plan.js";

function resize(width, height) {
  return {
    type: "resize",
    options: { width, height },
  };
}

function inventory(filters = ["scale", "setsar"]) {
  return { filters };
}

test("browser resize fits landscape and portrait sources", () => {
  const landscape = buildBrowserResizePlan(
    { width: 1920, height: 1080 },
    [resize(640, 640)],
    inventory(),
  );

  const portrait = buildBrowserResizePlan(
    { width: 1080, height: 1920 },
    [resize(640, 640)],
    inventory(),
  );

  assert.deepEqual(landscape.dimensions, {
    width: 640,
    height: 360,
  });

  assert.deepEqual(portrait.dimensions, {
    width: 360,
    height: 640,
  });

  assert.equal(landscape.video, "scale=w=640:h=360:flags=lanczos,setsar=1");
});

test("consecutive browser resizes preserve order and never upscale", () => {
  const result = buildBrowserResizePlan(
    { width: 320, height: 180 },
    [resize(160, 90), { type: "trim", options: { start: 0, end: 1 } }, resize(1280, 720)],
    inventory(),
  );

  assert.deepEqual(result.dimensions, {
    width: 160,
    height: 90,
  });

  assert.equal(
    result.video,
    "scale=w=160:h=90:flags=lanczos,setsar=1," + "scale=w=160:h=90:flags=lanczos,setsar=1",
  );
});

test("browser MP4 resize rounds down to even dimensions", () => {
  const result = buildBrowserResizePlan(
    { width: 320, height: 180 },
    [resize(101, 101)],
    inventory(),
  );

  assert.deepEqual(result.dimensions, {
    width: 100,
    height: 56,
  });
});

test("invalid browser resize boxes retain the original operation index", () => {
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
        buildBrowserResizePlan(
          { width: 320, height: 180 },
          [
            {
              type: "trim",
              options: { start: 0, end: 1 },
            },
            operation,
          ],
          inventory(),
        ),
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

test("browser resize rejects missing scale or square-pixel filters", () => {
  for (const missing of ["scale", "setsar"]) {
    assert.throws(
      () =>
        buildBrowserResizePlan(
          { width: 320, height: 180 },
          [resize(160, 90)],
          inventory(["scale", "setsar"].filter((filter) => filter !== missing)),
        ),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
        assert.equal(error.details.reason, "MISSING_FILTER");
        assert.equal(error.details.filter, missing);
        return true;
      },
    );
  }
});

test("browser resize plans preserve inputs and freeze their results", () => {
  const source = { width: 320, height: 180 };
  const transformations = [resize(160, 90)];
  const available = inventory();

  const before = structuredClone({
    source,
    transformations,
    available,
  });

  const result = buildBrowserResizePlan(source, transformations, available);

  assert.deepEqual({ source, transformations, available }, before);

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.dimensions), true);
});

test("plans without resize need no resize filters", () => {
  assert.equal(
    buildBrowserResizePlan(
      { width: 320, height: 180 },
      [
        {
          type: "convert",
          options: {
            format: "mp4",
            preset: "video-balanced-v1",
          },
        },
      ],
      inventory([]),
    ),
    undefined,
  );
});

test("browser resize rejects invalid source dimensions", () => {
  for (const width of [undefined, 0, -1, NaN, Infinity, 1.5]) {
    assert.throws(
      () => buildBrowserResizePlan({ width, height: 180 }, [resize(160, 90)], inventory()),
      (error) => {
        assert.equal(error.code, "INVALID_MEDIA");
        assert.equal(error.details.reason, "INVALID_SOURCE_DIMENSIONS");
        return true;
      },
    );
  }
});
