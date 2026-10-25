#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_JS_SHA256 = "67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3";
export const CORE_WASM_SHA256 = "9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Correct the pinned ESM binding, leaving the WASM and command arguments intact. */
export function patchBrowserCore(bytes) {
  assert.equal(
    sha256(bytes),
    CORE_JS_SHA256,
    "Unsupported core JavaScript; expected @ffmpeg/core@0.12.10 ESM.",
  );
  let source = bytes.toString("utf8");
  for (const method of ["ffmpeg", "ffprobe"]) {
    const original = `Module["_${method}"](args.length,stringsToPtr(args))`;
    assert.equal(source.split(original).length, 2, `Expected exactly one ${method} entry point.`);
    source = source.replace(
      original,
      `const mavioStack=stackSave();try{${original}}finally{stackRestore(mavioStack)}`,
    );
  }
  return Buffer.from(
    `/* Mavio stack restoration for @ffmpeg/core@0.12.10; WASM unchanged. */\n${source}`,
  );
}

export async function prepareBrowserAssets(destination) {
  const kit = process.env.MAVIO_BROWSER_ENGINE_KIT;
  assert.ok(
    typeof kit === "string" && kit.trim().length > 0,
    "MAVIO_BROWSER_ENGINE_KIT is required. Supply the pinned Mavio v2 engine kit; the original npm core is not a supported fallback.",
  );
  const { prepareBrowserAssetsFromKit } = await import("./browser-assets-kit.mjs");
  return prepareBrowserAssetsFromKit(destination, resolve(kit));
}

// npm uses a symlink in node_modules/.bin on POSIX.
if (
  process.argv[1] &&
  (await realpath(resolve(process.argv[1])).catch(() => undefined)) ===
    (await realpath(fileURLToPath(import.meta.url)))
) {
  if (process.argv.length !== 3) {
    console.error(
      "Usage: mavio-browser-assets <new-output-directory> (set MAVIO_BROWSER_ENGINE_KIT to the pinned v2 kit directory)",
    );
    process.exitCode = 1;
  } else {
    prepareBrowserAssets(resolve(process.argv[2])).then(
      (manifest) => console.log(JSON.stringify(manifest, null, 2)),
      (error) => {
        console.error(error);
        process.exitCode = 1;
      },
    );
  }
}
