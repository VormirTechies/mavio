import { createMavio } from "@vormir/mavio/browser";

export async function runBrowserBenchmark(fixtureURL) {
  const response = await fetch(fixtureURL);
  if (!response.ok) throw new Error("Benchmark fixture download failed.");
  const input = new Uint8Array(await response.arrayBuffer());

  async function hash(bytes) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }

  const originalHash = await hash(input);
  const phases = [];
  const exports = [];

  async function withClient(work) {
    const client = createMavio({
      browser: {
        assets: {
          coreURL: "/mavio-engine/ffmpeg-core.js",
          wasmURL: "/mavio-engine/ffmpeg-core.wasm",
          classWorkerURL: "/mavio-engine/wrapper/worker.js",
        },
      },
    });
    let value;
    let primary;
    let failed = false;

    try {
      value = await work(client);
    } catch (error) {
      failed = true;
      primary = error;
    }

    try {
      await client.dispose();
    } catch (error) {
      if (!failed) throw error;
    }

    if (failed) throw primary;
    return value;
  }

  function summarize(name, samplesMs) {
    const sorted = [...samplesMs].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return {
      name,
      samplesMs,
      minimumMs: sorted[0],
      medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
      maximumMs: sorted.at(-1),
    };
  }

  async function measure(name, count, work) {
    const samples = [];
    for (let index = 0; index < count; index++) {
      const started = performance.now();
      await work();
      samples.push(performance.now() - started);
    }
    phases.push(summarize(name, samples));
  }

  const initializationSamples = [];
  for (let index = 0; index < 3; index++) {
    await withClient(async (client) => {
      const started = performance.now();
      await client.capabilities();
      initializationSamples.push(performance.now() - started);
    });
  }
  phases.push(summarize("fresh-client capabilities", initializationSamples));

  await withClient(async (client) => {
    await client.capabilities();
    const source = client.from({
      kind: "bytes",
      bytes: input,
      name: "input.mp4",
    });
    await source.metadata();

    await measure("warm-client capabilities", 5, () => client.capabilities());
    await measure("warm-client metadata", 5, () => source.metadata());
    await measure("warm-client balanced MP4 byte export", 3, async () => {
      const result = await source
        .convert({ format: "mp4", preset: "video-balanced-v1" })
        .export({ output: { kind: "bytes" } });
      exports.push(result.output.bytes);
    });
  });

  return {
    phases,
    fixtureSha256: originalHash,
    sourceUnchanged: (await hash(input)) === originalHash,
    outputs: exports.map((bytes) => Array.from(bytes)),
    browserEnvironment: {
      userAgent: navigator.userAgent,
      logicalCpuCount: navigator.hardwareConcurrency,
    },
  };
}
