import assert from "node:assert/strict";
import test from "node:test";
import { probeBrowserInput } from "../../dist/engines/browser/probe.js";

function context(controller = new AbortController()) {
  return {
    jobId: "browser-probe-test",
    signal: controller.signal,
    reportProgress() {},
  };
}

function fixture(options = {}) {
  const directories = new Set();
  const files = new Map();
  const calls = [];
  let started;

  const probeStarted = new Promise((resolve) => {
    started = resolve;
  });

  const validReport = {
    format: {
      format_name: "wav",
      duration: "0.1",
      size: "3",
    },
    streams: [
      {
        index: 0,
        codec_type: "audio",
        codec_name: "pcm_s16le",
        sample_rate: "48000",
        channels: 1,
      },
    ],
  };

  const worker = {
    loaded: true,
    terminations: 0,

    async createDir(path) {
      calls.push(["mkdir", path]);
      if (directories.has(path)) throw new Error("Already exists.");
      directories.add(path);

      if (options.stale) {
        files.set(`${path}/probe.json`, JSON.stringify(validReport));
      }

      return true;
    },

    async writeFile(path, bytes) {
      calls.push(["write", path]);
      const transferred = structuredClone(bytes, {
        transfer: [bytes.buffer],
      });
      files.set(path, transferred);
      return true;
    },

    async listDir(path) {
      if (!directories.has(path)) throw new Error("Missing directory.");

      const prefix = `${path}/`;

      return [
        { name: ".", isDir: true },
        { name: "..", isDir: true },
        ...Array.from(files.keys())
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({
            name: name.slice(prefix.length),
            isDir: false,
          })),
      ];
    },

    async ffprobe(args) {
      calls.push(["probe", args]);
      started();

      if (options.stall) return new Promise(() => {});

      const output = args[args.indexOf("-o") + 1];

      if (!options.missingOutput) {
        files.set(output, JSON.stringify(options.report ?? validReport));
      }

      return options.exitCode ?? -1;
    },

    async readFile(path, encoding) {
      calls.push(["read", path, encoding]);
      if (!files.has(path)) throw new Error("Missing probe output.");
      return files.get(path);
    },

    async deleteFile(path) {
      calls.push(["unlink", path]);
      if (options.failCleanup) throw new Error("Unlink failed.");
      files.delete(path);
      return true;
    },

    async deleteDir(path) {
      calls.push(["rmdir", path]);
      directories.delete(path);
      return true;
    },

    terminate() {
      this.terminations += 1;
      this.loaded = false;
      directories.clear();
      files.clear();
    },
  };

  return { worker, directories, files, calls, probeStarted };
}

test("browser probe returns metadata, removes staging, and preserves caller bytes", async () => {
  for (const exitCode of [0, -1]) {
    const { worker, directories, files } = fixture({ exitCode });
    const bytes = new Uint8Array([1, 2, 3]);

    const metadata = await probeBrowserInput(worker, { kind: "bytes", bytes }, context());

    assert.equal(metadata.container, "wav");
    assert.equal(metadata.streams[0].sampleRate, 48000);
    assert.deepEqual(Array.from(bytes), [1, 2, 3]);
    assert.equal(directories.size, 0);
    assert.equal(files.size, 0);
    assert.equal(worker.terminations, 0);
    assert.equal(worker.loaded, true);
  }
});

test("browser probe stages Blob input and preserves the source", async () => {
  const { worker } = fixture();
  const blob = new Blob([new Uint8Array([1, 2, 3])]);

  const metadata = await probeBrowserInput(worker, { kind: "blob", blob }, context());

  assert.equal(metadata.durationSeconds, 0.1);
  assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [1, 2, 3]);
});

test("consecutive browser probes use different fresh output paths", async () => {
  const { worker, calls } = fixture();

  for (let index = 0; index < 2; index += 1) {
    await probeBrowserInput(worker, { kind: "bytes", bytes: new Uint8Array([1, 2, 3]) }, context());
  }

  const probes = calls.filter(([operation]) => operation === "probe");
  const outputs = probes.map(([, args]) => args[args.indexOf("-o") + 1]);

  assert.equal(outputs.length, 2);
  assert.notEqual(outputs[0], outputs[1]);

  for (const [, args] of probes) {
    assert.ok(args.includes("-show_error"));
    assert.ok(args.includes("-show_format"));
    assert.ok(args.includes("-show_streams"));
  }
});

test("invalid media discards its worker and virtual filesystem", async () => {
  const { worker, directories, files } = fixture({
    report: {
      error: {
        code: -1094995529,
        string: "Invalid media",
      },
    },
  });

  await assert.rejects(
    probeBrowserInput(worker, { kind: "bytes", bytes: new Uint8Array([1]) }, context()),
    { code: "INVALID_MEDIA" },
  );

  assert.equal(worker.terminations, 1);
  assert.equal(directories.size, 0);
  assert.equal(files.size, 0);
});

test("missing probe output cannot be mistaken for successful metadata", async () => {
  const { worker } = fixture({ missingOutput: true });

  await assert.rejects(
    probeBrowserInput(worker, { kind: "bytes", bytes: new Uint8Array([1]) }, context()),
    { code: "EXECUTION_FAILED" },
  );

  assert.equal(worker.terminations, 1);
});

test("cancelling a stalled probe terminates the worker", async () => {
  const controller = new AbortController();
  const { worker, probeStarted, directories } = fixture({ stall: true });

  const pending = probeBrowserInput(
    worker,
    { kind: "bytes", bytes: new Uint8Array([1]) },
    context(controller),
  );

  const rejected = assert.rejects(pending, { code: "CANCELLED" });

  await probeStarted;
  controller.abort();
  await rejected;

  assert.equal(worker.terminations, 1);
  assert.equal(directories.size, 0);
});

test("cleanup failure rejects metadata and discards the worker", async () => {
  const { worker, directories } = fixture({ failCleanup: true });

  await assert.rejects(
    probeBrowserInput(worker, { kind: "bytes", bytes: new Uint8Array([1]) }, context()),
    { code: "CLEANUP_FAILED" },
  );

  assert.equal(worker.terminations, 1);
  assert.equal(directories.size, 0);
});

test("preexisting probe output rejects before FFprobe execution", async () => {
  const { worker, calls } = fixture({ stale: true });

  await assert.rejects(
    probeBrowserInput(worker, { kind: "bytes", bytes: new Uint8Array([1]) }, context()),
    {
      code: "EXECUTION_FAILED",
      details: { reason: "STALE_PROBE_OUTPUT" },
    },
  );

  assert.equal(
    calls.some(([operation]) => operation === "probe"),
    false,
  );
  assert.equal(worker.terminations, 1);
});
