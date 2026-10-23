import { createMavio } from "@vormir/mavio/browser";
function requireElement(id, constructor) {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error("Missing or invalid page element: " + id);
  }
  return element;
}
function describeError(error) {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "EXAMPLE_FAILED";
    return code + ": " + error.message;
  }
  return "EXAMPLE_FAILED: Processing failed.";
}
const input = requireElement("media", HTMLInputElement);
const run = requireElement("run", HTMLButtonElement);
const cancel = requireElement("cancel", HTMLButtonElement);
const status = requireElement("status", HTMLPreElement);
const download = requireElement("download", HTMLAnchorElement);
const preview = requireElement("preview", HTMLVideoElement);
let active;
let outputURL;
cancel.addEventListener("click", () => {
  active?.abort();
});
run.addEventListener("click", async () => {
  if (active) return;
  const file = input.files?.[0];
  if (!file) {
    status.textContent = "Choose a video first.";
    return;
  }
  download.hidden = true;
  download.removeAttribute("href");
  preview.removeAttribute("src");
  preview.load();
  if (outputURL) {
    URL.revokeObjectURL(outputURL);
    outputURL = undefined;
  }
  const controller = new AbortController();
  active = controller;
  input.disabled = true;
  run.disabled = true;
  cancel.disabled = false;
  status.textContent = "Preparing.";
  let client;
  let output;
  let cleanupFailed = false;
  try {
    client = createMavio({
      browser: {
        assets: {
          coreURL: "/mavio-engine/ffmpeg-core.js",
          wasmURL: "/mavio-engine/ffmpeg-core.wasm",
          classWorkerURL: "/mavio-engine/wrapper/worker.js",
        },
      },
    });
    const result = await client
      .from({ kind: "blob", blob: file })
      .resize({ width: 640, height: 360 })
      .convert({ format: "mp4", preset: "video-balanced-v1" })
      .export(
        { output: { kind: "blob" } },
        {
          signal: controller.signal,
          onProgress(event) {
            status.textContent =
              event.stage + (event.percent === undefined ? "" : " " + event.percent + "%");
          },
        },
      );
    output = result.output.blob;
    cleanupFailed = (result.warnings?.length ?? 0) > 0;
  } catch (error) {
    status.textContent = describeError(error);
  } finally {
    try {
      await client?.dispose();
    } catch {
      cleanupFailed = true;
    }
    active = undefined;
    input.disabled = false;
    run.disabled = false;
    cancel.disabled = true;
  }
  if (output) {
    outputURL = URL.createObjectURL(output);
    download.href = outputURL;
    download.hidden = false;
    preview.src = outputURL;
    status.textContent = "Completed. Preview or download your MP4.";
  }
  if (cleanupFailed) {
    status.textContent += "\nCleanup reported a problem.";
  }
});
window.addEventListener("pagehide", () => {
  active?.abort();
  if (outputURL) URL.revokeObjectURL(outputURL);
});
