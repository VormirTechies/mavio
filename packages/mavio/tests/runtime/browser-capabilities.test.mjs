import assert from "node:assert/strict";
import test from "node:test";
import { createMavio } from "@vormirtech/mavio/browser";
import { createBrowserEngine } from "../../dist/engines/browser/adapter.js";
import { runBrowserWorkerCall } from "../../dist/engines/browser/worker-call.js";

function fixture({ failFirst = false, stallFirst = false } = {}) {
  const workers = [];
  let discoveries = 0;

  const source = {
    encoders: ["pcm_s16le"],
    decoders: ["h264", "pcm_s16le"],
    muxers: ["mp4", "wav"],
    demuxers: ["mov", "mp4", "wav"],
    filters: ["scale"],
  };

  const engine = createBrowserEngine(
    {
      assets: {
        coreURL: "/core.js",
        wasmURL: "/core.wasm",
        classWorkerURL: "/worker.js",
      },
    },
    {
      environment: {
        pageURL: "https://mavio.example/",
        baseURL: "https://mavio.example/",
      },

      async loader() {
        return () => {
          const worker = {
            loaded: false,
            terminations: 0,

            async load() {
              this.loaded = true;
              return true;
            },

            terminate() {
              this.terminations += 1;
              this.loaded = false;
            },
          };

          workers.push(worker);
          return worker;
        };
      },

      async inventory(worker, context) {
        discoveries += 1;

        if (discoveries === 1 && failFirst) {
          throw new Error("Simulated discovery failure.");
        }

        if (discoveries === 1 && stallFirst) {
          return runBrowserWorkerCall(worker, context, () => new Promise(() => {}));
        }

        return source;
      },
    },
  );

  return {
    engine,
    workers,
    source,
    discoveries: () => discoveries,
    client: createMavio({
      engine,
      initTimeoutMs: stallFirst ? 50 : 30_000,
    }),
  };
}

test("public browser capabilities discover inventory lazily and once", async () => {
  const { client, workers, discoveries } = fixture();

  assert.equal(discoveries(), 0);
  assert.equal(workers.length, 0);

  try {
    const first = await client.capabilities();
    const second = await client.capabilities();

    assert.deepEqual(first.readableContainers, ["mov", "mp4", "wav"]);
    assert.deepEqual(first.decoders, ["h264", "pcm_s16le"]);
    assert.deepEqual(first.operations, ["metadata", "convert", "compress", "extractAudio"]);

    assert.deepEqual(first.outputKinds, ["bytes", "blob"]);

    assert.deepEqual(first.encodings, [
      {
        container: "wav",
        audioCodec: "pcm_s16le",
        preset: "audio-pcm-v1",
      },
    ]);
    assert.deepEqual(second, first);

    assert.equal(discoveries(), 1);
    assert.equal(workers.length, 1);
  } finally {
    await client.dispose();
  }
});

test("browser adapter captures inventory independently of its provider", async () => {
  const { client, engine, source } = fixture();

  try {
    await client.capabilities();

    source.demuxers.push("unexpected");
    source.decoders.length = 0;

    const direct = await engine.capabilities();

    assert.deepEqual(direct.readableContainers, ["mov", "mp4", "wav"]);
    assert.deepEqual(direct.decoders, ["h264", "pcm_s16le"]);

    direct.readableContainers.push("caller-change");
    direct.decoders.length = 0;

    const again = await engine.capabilities();

    assert.deepEqual(again.readableContainers, ["mov", "mp4", "wav"]);
    assert.deepEqual(again.decoders, ["h264", "pcm_s16le"]);
  } finally {
    await client.dispose();
  }
});

test("failed browser inventory releases the worker and permits a fresh retry", async () => {
  const { client, workers, discoveries } = fixture({ failFirst: true });

  try {
    await assert.rejects(client.capabilities(), {
      code: "ENGINE_INIT_FAILED",
    });

    assert.equal(workers[0].terminations, 1);

    const recovered = await client.capabilities();

    assert.ok(recovered.decoders.includes("pcm_s16le"));
    assert.equal(discoveries(), 2);
    assert.equal(workers.length, 2);
  } finally {
    await client.dispose();
  }

  assert.equal(workers[0].terminations, 1);
  assert.equal(workers[1].terminations, 1);
});

test("the initialization deadline also covers browser inventory discovery", async () => {
  const { client, workers } = fixture({ stallFirst: true });

  try {
    await assert.rejects(client.capabilities(), {
      code: "ENGINE_INIT_FAILED",
      details: { reason: "TIMEOUT" },
    });

    assert.equal(workers[0].terminations, 1);

    const recovered = await client.capabilities();

    assert.ok(recovered.readableContainers.includes("wav"));
    assert.equal(workers.length, 2);
  } finally {
    await client.dispose();
  }
});

test("disposal before first use never discovers browser inventory", async () => {
  const { client, workers, discoveries } = fixture();

  await client.dispose();

  assert.equal(discoveries(), 0);
  assert.equal(workers.length, 0);
});
