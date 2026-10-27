import assert from "node:assert/strict";
import test from "node:test";
import { createMavio } from "@vormirtech/mavio/browser";
import { createBrowserEngine } from "../../dist/engines/browser/adapter.js";

const environment = {
  pageURL: "https://mavio.example/index.html",
  baseURL: "https://mavio.example/",
};

const options = {
  assets: {
    coreURL: "/core.js",
    wasmURL: "/core.wasm",
    classWorkerURL: "/worker.js",
  },
};

function fixture({ failFirst = false } = {}) {
  const workers = [];
  let imports = 0;

  const engine = createBrowserEngine(options, {
    environment,

    async inventory() {
      return {
        encoders: [],
        decoders: ["pcm_s16le"],
        muxers: [],
        demuxers: ["wav"],
        filters: [],
      };
    },

    async loader() {
      imports += 1;

      return () => {
        const worker = {
          loaded: false,
          loadCalls: 0,
          terminationCount: 0,

          async load() {
            this.loadCalls += 1;

            if (failFirst && workers.length === 1) {
              throw new Error("Simulated core load failure.");
            }

            this.loaded = true;
            return true;
          },

          terminate() {
            this.terminationCount += 1;
            this.loaded = false;
          },
        };

        workers.push(worker);
        return worker;
      };
    },
  });

  const client = createMavio({ engine });

  return {
    client,
    workers,
    imports: () => imports,
  };
}

test("an unused browser client creates no worker, including on disposal", async () => {
  const { client, workers, imports } = fixture();

  client.from({
    kind: "bytes",
    bytes: new Uint8Array([1, 2, 3]),
  });

  assert.equal(imports(), 0);
  assert.equal(workers.length, 0);

  await client.dispose();
  await client.dispose();

  assert.equal(imports(), 0);
  assert.equal(workers.length, 0);
});

test("browser capabilities initialize once and reuse the loaded worker", async () => {
  const { client, workers, imports } = fixture();

  try {
    const first = await client.capabilities();
    const second = await client.capabilities();

    assert.equal(imports(), 1);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].loadCalls, 1);
    assert.equal(first.runtime, "browser");
    assert.equal(first.engineId, "browser-ffmpeg");
    assert.equal(first.engineVersion, "ffmpeg 5.1.10 (Mavio Browser core)");
    assert.deepEqual(first.operations, ["metadata"]);
    assert.deepEqual(first.encodings, []);
    assert.deepEqual(second, first);
  } finally {
    await client.dispose();
  }

  assert.equal(workers[0].terminationCount, 1);
});

test("concurrent capability requests share the serialized browser session", async () => {
  const { client, workers, imports } = fixture();

  try {
    const results = await Promise.all([
      client.capabilities(),
      client.capabilities(),
      client.capabilities(),
    ]);

    assert.equal(results.length, 3);
    assert.equal(imports(), 1);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].loadCalls, 1);
  } finally {
    await client.dispose();
  }
});

test("browser initialization failure permits a later fresh-worker retry", async () => {
  const { client, workers, imports } = fixture({ failFirst: true });

  try {
    await assert.rejects(client.capabilities(), {
      code: "ENGINE_INIT_FAILED",
    });

    assert.equal(workers.length, 1);
    assert.equal(workers[0].terminationCount, 1);

    const capabilities = await client.capabilities();

    assert.equal(capabilities.runtime, "browser");
    assert.equal(imports(), 2);
    assert.equal(workers.length, 2);
    assert.equal(workers[1].loaded, true);
  } finally {
    await client.dispose();
  }

  assert.equal(workers[0].terminationCount, 1);
  assert.equal(workers[1].terminationCount, 1);
});

test("browser client disposal terminates once and prevents further work", async () => {
  const { client, workers, imports } = fixture();

  await client.capabilities();
  await client.dispose();
  await client.dispose();

  assert.equal(workers[0].terminationCount, 1);

  await assert.rejects(client.capabilities(), {
    code: "DISPOSED",
  });

  assert.equal(imports(), 1);
});

test("browser capabilities returned to callers are independent snapshots", async () => {
  const { client } = fixture();

  try {
    const first = await client.capabilities();
    first.operations.push("trim");
    first.encodings.push({
      container: "mp4",
      preset: "video-balanced-v1",
    });

    const second = await client.capabilities();

    assert.deepEqual(second.operations, ["metadata"]);
    assert.deepEqual(second.encodings, []);
  } finally {
    await client.dispose();
  }
});

test("the default browser entry rejects native configuration", () => {
  assert.throws(
    () =>
      createMavio({
        native: {},
        browser: options,
      }),
    { code: "INVALID_OPTIONS" },
  );
});
