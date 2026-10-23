import type { DiagnosticEvent } from "@vormir/mavio";
import { SDK_VERSION } from "@vormir/mavio";
import type { MavioClient, MediaResult, PresetId } from "@vormir/mavio";
import type { MavioClient as BrowserClient } from "@vormir/mavio/browser";
import type { MavioClient as NodeClient } from "@vormir/mavio/node";
import { createMavio } from "@vormir/mavio";
import { createMavio as createBrowserMavio } from "@vormir/mavio/browser";
import { createMavio as createNodeMavio } from "@vormir/mavio/node";
import type { EngineAdapter } from "@vormir/mavio";

declare const client: MavioClient;
declare const adapter: EngineAdapter;

const browserClient: BrowserClient = client;
const nodeClient: NodeClient = client;
const version: string = SDK_VERSION;
const preset: PresetId = "audio-pcm-v1";

async function verifyOutputs() {
  const blobResult = await client
    .from({ kind: "blob", blob: new Blob(["fixture"]) })
    .compress({ preset: "video-balanced-v1" })
    .export({ format: "mp4", output: { kind: "blob" } });

  const blob: Blob = blobResult.output.blob;

  // @ts-expect-error Blob outputs do not expose a file path.
  blobResult.output.path;

  const pathResult = await client
    .from({ kind: "path", path: "input.mp4" })
    .extractAudio()
    .convert({ format: "wav", preset })
    .export({ output: { kind: "path", path: "output.wav" } });

  const path: string = pathResult.output.path;

  // @ts-expect-error Time values must be numbers.
  client.from({ kind: "path", path }).trim({ start: "1", end: 2 });

  return { blob, path };
}

// @ts-expect-error Unknown presets must be rejected.
const invalidPreset: PresetId = "unknown";

declare const bytesResult: MediaResult<{ kind: "bytes" }>;
const bytes: Uint8Array = bytesResult.output.bytes;

void browserClient;
void nodeClient;
void version;
void verifyOutputs;
void invalidPreset;
void bytes;

const rootFactoryClient: MavioClient = createMavio({ engine: adapter });
const browserFactoryClient: MavioClient = createBrowserMavio({ engine: adapter });
const nodeFactoryClient: MavioClient = createNodeMavio({ engine: adapter });

// @ts-expect-error Queue capacity must be a number.
createMavio({ engine: adapter, maxQueuedJobs: "16" });

// @ts-expect-error Engine runtime must be node or browser.
createMavio({ engine: { ...adapter, runtime: "desktop" } });

void rootFactoryClient;
void browserFactoryClient;
void nodeFactoryClient;

async function verifyDxContracts() {
  const source = client.from({
    kind: "bytes",
    bytes: new Uint8Array(),
    name: "input.mp4",
  });

  const thumbnailBytes = await source.thumbnail({
    at: 0,
    format: "jpeg",
    preset: "jpeg-balanced-v1",
    output: { kind: "bytes" },
  });

  const imageBytes: Uint8Array = thumbnailBytes.output.bytes;

  // @ts-expect-error Byte outputs do not expose a Blob.
  thumbnailBytes.output.blob;

  // @ts-expect-error Byte outputs do not expose a file path.
  thumbnailBytes.output.path;

  const thumbnailBlob = await source.thumbnail({
    at: 0,
    format: "png",
    preset: "png-lossless-v1",
    output: { kind: "blob" },
  });

  const imageBlob: Blob = thumbnailBlob.output.blob;

  // @ts-expect-error Blob outputs do not expose bytes directly.
  thumbnailBlob.output.bytes;

  const inventory = await client.capabilities();

  const encodingPreset: PresetId | undefined = inventory.encodings[0]?.preset;
  const maximumBytes: number | undefined = inventory.limits.maxInputBytes;

  // @ts-expect-error Capability operation arrays are readonly.
  inventory.operations.push("trim");

  // @ts-expect-error Capability encoding arrays are readonly.
  inventory.encodings.push({
    container: "wav",
    preset: "audio-pcm-v1",
    audioCodec: "pcm_s16le",
  });

  await source.metadata({
    onProgress(event) {
      const jobId: string = event.jobId;
      const percent: number | undefined = event.percent;

      // @ts-expect-error Progress callback events are readonly.
      event.stage = "running";

      void jobId;
      void percent;
    },
  });

  void imageBytes;
  void imageBlob;
  void encodingPreset;
  void maximumBytes;
}

void verifyDxContracts;

function verifyDiagnosticTypes() {
  const configured = createMavio({
    engine: adapter,
    onDiagnostic(event) {
      const snapshot: Readonly<DiagnosticEvent> = event;
      const runtime: "node" | "browser" = event.runtime;

      if (event.type === "job-error") {
        const code: string = event.code;
        void code;
      } else {
        const percent: number | undefined = event.percent;
        void percent;

        // @ts-expect-error Progress diagnostics do not expose an error code.
        event.code;
      }

      // @ts-expect-error Diagnostic events are readonly.
      event.jobId = "changed";

      // @ts-expect-error Diagnostics do not expose input paths.
      event.path;

      // @ts-expect-error Diagnostics do not expose original causes.
      event.cause;

      void snapshot;
      void runtime;
    },
  });

  // @ts-expect-error The diagnostic observer must be a function.
  createMavio({ engine: adapter, onDiagnostic: true });

  void configured;
}

void verifyDiagnosticTypes;
