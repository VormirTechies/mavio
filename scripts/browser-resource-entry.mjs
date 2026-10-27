import { createMavio } from "@vormirtech/mavio/browser";

let source;
let sourceHash;
let client;
let assets;
let retained = [];

async function digest(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function createClient() {
  return createMavio({ browser: { assets } });
}

async function expectCode(work, expected) {
  try {
    await work();
  } catch (error) {
    require(error?.code === expected, `Expected ${expected}; received ${String(error?.code)}.`);
    return;
  }

  throw new Error(`Expected rejection with ${expected}.`);
}

function exportBytes(input, execution) {
  return client
    .from(input)
    .compress({ preset: "video-balanced-v1" })
    .export({ format: "mp4", output: { kind: "bytes" } }, execution);
}

export async function initializeResourceRun(fixtureURL, workerURL) {
  require(client === undefined, "Resource workload already initialized.");

  const response = await fetch(fixtureURL);
  require(response.ok, "Could not load the resource fixture.");

  source = new Uint8Array(await response.arrayBuffer());
  sourceHash = await digest(source);
  assets = {
    coreURL: new URL("/mavio-engine/ffmpeg-core.js", globalThis.location.href).href,
    wasmURL: new URL("/mavio-engine/ffmpeg-core.wasm", globalThis.location.href).href,
    classWorkerURL: new URL(workerURL, globalThis.location.href).href,
  };

  client = createClient();

  try {
    const capabilities = await client.capabilities();
    const metadata = await client.from({ kind: "bytes", bytes: source }).metadata();

    require(capabilities.runtime === "browser", "Unexpected runtime.");
    require(metadata.streams.some(
      (stream) => stream.kind === "video",
    ), "Resource fixture requires a video stream.");

    return {
      sourceBytes: source.byteLength,
      sourceSHA256: sourceHash,
      metadata,
    };
  } catch (error) {
    await client.dispose().catch(() => {});
    throw error;
  }
}

export async function runResourceBatch(batch) {
  require(Number.isInteger(batch) && batch >= 1, "Invalid batch number.");

  for (let index = 0; index < 5; index += 1) {
    const input =
      index % 2 === 0
        ? { kind: "bytes", bytes: source }
        : { kind: "blob", blob: new Blob([source], { type: "video/mp4" }) };

    const result = await exportBytes(input);
    require(result.output.bytes.byteLength > 0, "Export returned empty bytes.");

    retained.push({
      batch,
      index,
      bytes: result.output.bytes,
      hash: await digest(result.output.bytes),
    });
  }

  await expectCode(
    () => client.from({ kind: "bytes", bytes: new Uint8Array([1, 2, 3]) }).metadata(),
    "INVALID_MEDIA",
  );

  const controller = new AbortController();
  const observer = globalThis.__mavioResourceObserver;

  require(observer !== undefined, "Resource observer was not installed.");

  observer.cancelNextExec(() => controller.abort());

  try {
    await expectCode(
      () => exportBytes({ kind: "bytes", bytes: source }, { signal: controller.signal }),
      "CANCELLED",
    );
  } finally {
    observer.clearExecCancellation();
  }

  require(controller.signal.aborted, "No EXEC dispatch triggered cancellation.");

  const recovered = await client.from({ kind: "bytes", bytes: source }).metadata();

  require(recovered.streams.some(
    (stream) => stream.kind === "video",
  ), "Same-client metadata recovery failed.");
  require((await digest(source)) === sourceHash, "Caller source bytes changed.");

  return {
    batch,
    exports: 5,
    invalidMedia: 1,
    executionDispatchCancellation: 1,
    recoveryMetadata: 1,
    retainedOutputs: retained.length,
  };
}

export async function disposeResourceRun() {
  require(client !== undefined, "Resource client was not initialized.");
  await client.dispose();

  for (const output of retained) {
    require((await digest(output.bytes)) ===
      output.hash, "Retained output changed after disposal.");
  }

  require((await digest(source)) === sourceHash, "Caller source changed after disposal.");

  return {
    retainedOutputs: retained.length,
    retainedOutputBytes: retained.reduce((total, output) => total + output.bytes.byteLength, 0),
    outputHashesVerifiedAfterDisposal: true,
    sourceUnchanged: true,
  };
}

export async function runFreshClientCycles() {
  for (let index = 0; index < 5; index += 1) {
    const fresh = createClient();

    try {
      await fresh.from({ kind: "bytes", bytes: source }).metadata();
    } finally {
      await fresh.dispose();
    }
  }

  return { freshClientCycles: 5 };
}

export function collectResourceOutputs() {
  return retained.map(({ batch, index, bytes, hash }) => ({
    batch,
    index,
    bytes: Array.from(bytes),
    sha256: hash,
  }));
}

export function releaseResourceOutputs() {
  retained = [];
}

export async function cleanupResourceRun() {
  await client?.dispose();
}
