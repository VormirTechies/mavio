import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createMavio } from "../../dist/node.js";
import { createMavioError } from "../../dist/core/errors.js";
import { createNativeEngine } from "../../dist/engines/native/adapter.js";

function fixture(hooks = {}) {
  const events = [];
  const metadata = {
    durationSeconds: 2,
    sizeBytes: 3,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    streams: [
      {
        index: 0,
        kind: "video",
        codec: "h264",
        width: 320,
        height: 180,
      },
    ],
  };

  const target = resolve("published.mp4");
  const staged = resolve("private-staging", "output.mp4");

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
          encoders: ["libx264", "aac"],
          decoders: [],
          muxers: ["mp4"],
          demuxers: [],
          filters: [],
        };
      },
      async probeDetails() {
        return {
          metadata: structuredClone(metadata),
          streams: [
            {
              index: 0,
              attachedPicture: false,
              pixelFormat: "yuv420p",
              colorTransfer: "bt709",
              colorPrimaries: "bt709",
              colorSpace: "bt709",
              colorRange: "tv",
            },
          ],
        };
      },
      async pathWorkspace(path) {
        events.push("workspace");
        assert.equal(path, target);
        await hooks.workspace?.();

        return {
          async dispose() {
            events.push("cleanup");
            await hooks.cleanup?.();
          },
        };
      },
      async prepareFile() {
        events.push("prepare-file");
        return { path: staged, metadata: structuredClone(metadata) };
      },
      async publish(source, destination, context) {
        assert.equal(source, staged);
        assert.equal(destination, target);
        events.push("publish");

        if (!context.beginCommit()) {
          throw createMavioError("CANCELLED", "Publication denied.");
        }

        await hooks.publish?.();
      },
    },
  );

  return { engine, events, target };
}

function exportFile(client, target, signal) {
  return client
    .from({ kind: "path", path: resolve("source.mp4") })
    .compress({ preset: "video-balanced-v1" })
    .export({ format: "mp4", output: { kind: "path", path: target } }, { signal });
}

test("public path export publishes before staging cleanup", async () => {
  const state = fixture();
  const client = createMavio({ engine: state.engine });

  try {
    const result = await exportFile(client, state.target);
    assert.deepEqual(result.output, { kind: "path", path: state.target });
    assert.equal(result.warnings, undefined);
    assert.deepEqual(state.events, ["workspace", "prepare-file", "publish", "cleanup"]);
  } finally {
    await client.dispose();
  }
});

test("occupied destinations reject before encoding", async () => {
  const state = fixture({
    workspace() {
      throw createMavioError("OUTPUT_EXISTS", "Occupied.");
    },
  });
  const client = createMavio({ engine: state.engine });

  try {
    await assert.rejects(exportFile(client, state.target), {
      code: "OUTPUT_EXISTS",
    });
    assert.deepEqual(state.events, ["workspace"]);
  } finally {
    await client.dispose();
  }
});

test("post-publication cleanup failure returns a warning and disposal retries", async () => {
  let cleanups = 0;
  const state = fixture({
    cleanup() {
      if (++cleanups === 1) throw new Error("Cleanup failed");
    },
  });
  const client = createMavio({ engine: state.engine });

  try {
    const result = await exportFile(client, state.target);
    assert.equal(result.output.path, state.target);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, "CLEANUP_FAILED");
  } finally {
    await client.dispose();
  }

  assert.equal(cleanups, 2);
});

test("publication failure is retained and staging is cleaned up", async () => {
  const state = fixture({
    publish() {
      throw createMavioError("OUTPUT_EXISTS", "Another writer won.");
    },
  });
  const client = createMavio({ engine: state.engine });

  try {
    await assert.rejects(exportFile(client, state.target), {
      code: "OUTPUT_EXISTS",
      message: "Another writer won.",
    });

    assert.deepEqual(state.events, ["workspace", "prepare-file", "publish", "cleanup"]);
  } finally {
    await client.dispose();
  }
});

test("cancellation after the publication gate does not invalidate success", async () => {
  const controller = new AbortController();
  const state = fixture({
    publish() {
      controller.abort("after commit");
    },
  });
  const client = createMavio({ engine: state.engine });

  try {
    const result = await exportFile(client, state.target, controller.signal);
    assert.equal(result.output.path, state.target);
    assert.equal(state.events.at(-1), "cleanup");
  } finally {
    await client.dispose();
  }
});
