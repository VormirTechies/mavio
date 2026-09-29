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
