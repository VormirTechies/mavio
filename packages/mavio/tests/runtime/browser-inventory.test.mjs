import assert from "node:assert/strict";
import test from "node:test";
import { discoverBrowserInventory } from "../../dist/engines/browser/inventory.js";

const tables = {
  encoders: [
    "Encoders:",
    " ------",
    " V..... libx264 H.264 encoder",
    " A..... pcm_s16le PCM encoder",
  ],
  decoders: ["Decoders:", " ------", " V..... h264 H.264 decoder", " A..... pcm_s16le PCM decoder"],
  muxers: ["File formats:", " --", "  E mp4 MP4", "  E wav WAV"],
  demuxers: ["File formats:", " --", " D  mov,mp4 MOV/MP4", " D  wav WAV"],
  filters: ["Filters:", " ------", " ... scale V->V Scale video", " ... atrim A->A Trim audio"],
};

function context(controller = new AbortController()) {
  return {
    jobId: "browser-inventory-test",
    signal: controller.signal,
    reportProgress() {},
  };
}

function fixture(options = {}) {
  const listeners = new Set();
  const calls = [];
  let started;

  const entered = new Promise((resolve) => {
    started = resolve;
  });

  const worker = {
    loaded: true,
    terminations: 0,

    on(event, callback) {
      assert.equal(event, "log");
      listeners.add(callback);
    },

    off(event, callback) {
      assert.equal(event, "log");
      listeners.delete(callback);
    },

    async exec(args) {
      calls.push(args);
      started();

      if (options.stall) return new Promise(() => {});
      if (options.failure) throw options.failure;

      const kind = args[1].slice(1);
      const rows = options.rows ?? tables[kind];

      for (const callback of listeners) {
        callback({
          type: "stderr",
          message: "Diagnostic text that must not enter the table.",
        });
      }

      for (const message of rows) {
        for (const callback of listeners) {
          callback({ type: "stdout", message });
        }
      }

      return options.exitCode ?? 0;
    },

    terminate() {
      this.terminations += 1;
      this.loaded = false;
    },
  };

  return { worker, listeners, calls, entered };
}

test("browser inventory parses all five lists and expands format aliases", async () => {
  const { worker, calls } = fixture();
  const inventory = await discoverBrowserInventory(worker, context());

  assert.deepEqual(inventory.encoders, ["libx264", "pcm_s16le"]);
  assert.deepEqual(inventory.decoders, ["h264", "pcm_s16le"]);
  assert.deepEqual(inventory.muxers, ["mp4", "wav"]);
  assert.deepEqual(inventory.demuxers, ["mov", "mp4", "wav"]);
  assert.deepEqual(inventory.filters, ["atrim", "scale"]);

  assert.deepEqual(
    calls.map((args) => args[1]),
    ["-encoders", "-decoders", "-muxers", "-demuxers", "-filters"],
  );

  assert.equal(worker.terminations, 0);
});

test("browser inventory is frozen and excludes diagnostic output", async () => {
  const { worker, listeners } = fixture();
  const inventory = await discoverBrowserInventory(worker, context());

  assert.equal(Object.isFrozen(inventory), true);

  for (const names of Object.values(inventory)) {
    assert.equal(Object.isFrozen(names), true);
    assert.equal(
      names.some((name) => name.includes("Diagnostic")),
      false,
    );
  }

  assert.equal(listeners.size, 0);
});

test("capability queries reject nonzero exits including -1", async () => {
  for (const exitCode of [1, -1]) {
    const { worker, calls, listeners } = fixture({ exitCode });

    await assert.rejects(discoverBrowserInventory(worker, context()), {
      code: "ENGINE_INIT_FAILED",
      details: {
        reason: "CAPABILITY_QUERY_FAILED",
        list: "encoders",
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(worker.terminations, 1);
    assert.equal(listeners.size, 0);
  }
});

test("malformed capability tables reject instead of inventing support", async () => {
  const { worker, listeners } = fixture({
    rows: ["Encoders:", " ------", "unrecognized row"],
  });

  await assert.rejects(discoverBrowserInventory(worker, context()), { code: "ENGINE_INIT_FAILED" });

  assert.equal(worker.terminations, 1);
  assert.equal(listeners.size, 0);
});

test("capability output has a bounded capture size", async () => {
  const { worker, listeners } = fixture({
    rows: ["x".repeat(1_048_577)],
  });

  await assert.rejects(discoverBrowserInventory(worker, context()), {
    code: "ENGINE_INIT_FAILED",
    details: {
      reason: "CAPABILITY_OUTPUT_LIMIT",
      list: "encoders",
    },
  });

  assert.equal(worker.terminations, 1);
  assert.equal(listeners.size, 0);
});

test("cancellation interrupts a stalled capability query", async () => {
  const controller = new AbortController();
  const { worker, entered, listeners } = fixture({ stall: true });

  const pending = discoverBrowserInventory(worker, context(controller));

  const rejected = assert.rejects(pending, { code: "CANCELLED" });

  await entered;
  controller.abort();
  await rejected;

  assert.equal(worker.terminations, 1);
  assert.equal(listeners.size, 0);
});

test("capability runner failures preserve their cause", async () => {
  const failure = new Error("Simulated worker execution failure.");
  const { worker, listeners } = fixture({ failure });

  await assert.rejects(discoverBrowserInventory(worker, context()), (error) => {
    assert.equal(error.code, "ENGINE_INIT_FAILED");
    assert.equal(error.cause, failure);
    return true;
  });

  assert.equal(worker.terminations, 1);
  assert.equal(listeners.size, 0);
});

test("sequential discovery removes old listeners before another attempt", async () => {
  const { worker, listeners, calls } = fixture();

  const first = await discoverBrowserInventory(worker, context());
  const second = await discoverBrowserInventory(worker, context());

  assert.deepEqual(second, first);
  assert.equal(calls.length, 10);
  assert.equal(listeners.size, 0);
  assert.equal(worker.terminations, 0);
});
