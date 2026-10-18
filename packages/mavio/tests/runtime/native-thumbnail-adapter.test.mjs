import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createNativeEngine } from "../../dist/engines/native/adapter.js";

async function capabilities(encoders, filters = ["trim", "setpts", "scale", "format"]) {
  const engine = createNativeEngine(
    {},
    {
      async prepare() {
        return {
          ffmpeg: { path: resolve("ffmpeg"), version: "test" },
          ffprobe: { path: resolve("ffprobe"), version: "test" },
        };
      },
      async inventory() {
        return {
          encoders,
          decoders: [],
          muxers: ["image2pipe", "framemd5"],
          demuxers: [],
          filters,
        };
      },
    },
  );

  try {
    await engine.initialize({
      jobId: "thumbnail-capabilities",
      signal: new AbortController().signal,
      reportProgress() {},
    });

    return await engine.capabilities();
  } finally {
    await engine.dispose();
  }
}

test("JPEG thumbnail capabilities do not require PNG or audio encoders", async () => {
  const result = await capabilities(["rawvideo", "mjpeg"]);

  assert.deepEqual(
    result.encodings.map((item) => item.preset),
    ["jpeg-balanced-v1"],
  );
  assert.ok(result.operations.includes("thumbnail"));
  assert.ok(result.operations.includes("trim"));
  assert.ok(!result.operations.includes("resize"));
  assert.ok(!result.operations.includes("compress"));
  assert.deepEqual(result.outputKinds, ["bytes", "path"]);
});

test("PNG thumbnail capabilities do not require JPEG or audio encoders", async () => {
  const result = await capabilities(["rawvideo", "png"]);

  assert.deepEqual(
    result.encodings.map((item) => item.preset),
    ["png-lossless-v1"],
  );
  assert.ok(result.operations.includes("thumbnail"));
});

test("thumbnail capabilities require the frame analysis encoder", async () => {
  const result = await capabilities(["mjpeg", "png"]);

  assert.deepEqual(result.encodings, []);
  assert.ok(!result.operations.includes("thumbnail"));
  assert.deepEqual(result.outputKinds, []);
});

test("thumbnail capabilities require every command filter", async () => {
  for (const missing of ["trim", "setpts", "scale", "format"]) {
    const result = await capabilities(
      ["rawvideo", "mjpeg", "png"],
      ["trim", "setpts", "scale", "format"].filter((name) => name !== missing),
    );

    assert.deepEqual(result.encodings, [], `Missing filter: ${missing}`);
    assert.ok(!result.operations.includes("thumbnail"));
  }
});

test("thumbnail-only engines advertise resize when square-pixel conversion is available", async () => {
  const result = await capabilities(
    ["rawvideo", "png"],
    ["trim", "setpts", "scale", "format", "setsar"],
  );

  assert.ok(result.operations.includes("thumbnail"));
  assert.ok(result.operations.includes("resize"));
  assert.ok(!result.operations.includes("compress"));
});
