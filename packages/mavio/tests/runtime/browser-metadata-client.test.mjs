import assert from "node:assert/strict";
import test from "node:test";
import { createMavio } from "@vormirtech/mavio/browser";
import { createMavioError } from "../../dist/core/errors.js";
import { createBrowserEngine } from "../../dist/engines/browser/adapter.js";

const metadata = {
  container: "wav",
  durationSeconds: 0.1,
  sizeBytes: 9600,
  streams: [
    {
      index: 0,
      kind: "audio",
      codec: "pcm_s16le",
      sampleRate: 48000,
      channels: 1,
    },
  ],
};

function fixture(probeImplementation = async () => metadata) {
  const workers = [];
  const probes = [];

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
        pageURL: "https://mavio.example/index.html",
        baseURL: "https://mavio.example/",
      },

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

      async probe(worker, input, context) {
        probes.push({ worker, input, context });
        return probeImplementation(worker, input, context);
      },
    },
  );

  return {
    client: createMavio({ engine }),
    workers,
    probes,
  };
}

test("public browser metadata accepts bytes and Blob inputs", async () => {
  const { client, workers, probes } = fixture();

  try {
    for (const input of [
      { kind: "bytes", bytes: new Uint8Array([1, 2, 3]) },
      { kind: "blob", blob: new Blob(["media"]) },
    ]) {
      const result = await client.from(input).metadata();
      assert.deepEqual(result, metadata);
    }

    assert.equal(workers.length, 1);
    assert.deepEqual(
      probes.map(({ input }) => input.kind),
      ["bytes", "blob"],
    );

    for (const { context } of probes) {
      assert.equal(typeof context.jobId, "string");
      assert.equal(context.signal.aborted, false);
    }
  } finally {
    await client.dispose();
  }

  assert.equal(workers[0].terminations, 1);
});

test("public metadata failure resets an already terminated worker and recovers", async () => {
  let attempts = 0;

  const { client, workers } = fixture(async (worker) => {
    attempts += 1;

    if (attempts === 1) {
      // Match the real probe helper's failure behavior.
      worker.terminate();

      throw createMavioError("INVALID_MEDIA", "Simulated invalid media.", { stage: "preparing" });
    }

    return metadata;
  });

  try {
    await assert.rejects(
      client
        .from({
          kind: "bytes",
          bytes: new Uint8Array([1]),
        })
        .metadata(),
      { code: "INVALID_MEDIA" },
    );

    assert.equal(workers[0].terminations, 1);

    const result = await client
      .from({
        kind: "bytes",
        bytes: new Uint8Array([2]),
      })
      .metadata();

    assert.deepEqual(result, metadata);
    assert.equal(workers.length, 2);
    assert.equal(workers[1].loaded, true);
  } finally {
    await client.dispose();
  }

  assert.equal(workers[0].terminations, 1);
  assert.equal(workers[1].terminations, 1);
});

test("returned browser metadata does not expose adapter-owned objects", async () => {
  const { client } = fixture();

  try {
    const pipeline = client.from({
      kind: "bytes",
      bytes: new Uint8Array([1]),
    });

    const first = await pipeline.metadata();
    first.streams[0].sampleRate = 1;
    first.streams.push({ index: 99, kind: "other" });

    const second = await pipeline.metadata();

    assert.equal(second.streams.length, 1);
    assert.equal(second.streams[0].sampleRate, 48000);
    assert.equal(metadata.streams[0].sampleRate, 48000);
  } finally {
    await client.dispose();
  }
});

test("public browser paths reject before worker creation", async () => {
  const { client, workers, probes } = fixture();

  try {
    await assert.rejects(
      client
        .from({
          kind: "path",
          path: "fixture.wav",
        })
        .metadata(),
      { code: "UNSUPPORTED_CAPABILITY" },
    );

    assert.equal(workers.length, 0);
    assert.equal(probes.length, 0);
  } finally {
    await client.dispose();
  }
});

test("pre-aborted metadata rejects without creating a worker", async () => {
  const { client, workers, probes } = fixture();
  const controller = new AbortController();
  controller.abort();

  try {
    await assert.rejects(
      client
        .from({
          kind: "bytes",
          bytes: new Uint8Array([1]),
        })
        .metadata({ signal: controller.signal }),
      { code: "CANCELLED" },
    );

    assert.equal(workers.length, 0);
    assert.equal(probes.length, 0);
  } finally {
    await client.dispose();
  }
});

test("metadata after client disposal rejects without reinitialization", async () => {
  const { client, workers, probes } = fixture();

  const pipeline = client.from({
    kind: "bytes",
    bytes: new Uint8Array([1]),
  });

  await pipeline.metadata();
  await client.dispose();

  await assert.rejects(pipeline.metadata(), { code: "DISPOSED" });

  assert.equal(workers.length, 1);
  assert.equal(probes.length, 1);
  assert.equal(workers[0].terminations, 1);
});

test("concurrent public metadata requests remain serialized", async () => {
  let active = 0;
  let maximumActive = 0;

  const { client, workers, probes } = fixture(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);

    try {
      await new Promise((resolve) => setImmediate(resolve));
      return metadata;
    } finally {
      active -= 1;
    }
  });

  try {
    await Promise.all(
      [1, 2, 3].map((value) =>
        client
          .from({
            kind: "bytes",
            bytes: new Uint8Array([value]),
          })
          .metadata(),
      ),
    );

    assert.equal(maximumActive, 1);
    assert.equal(probes.length, 3);
    assert.equal(workers.length, 1);
  } finally {
    await client.dispose();
  }
});
