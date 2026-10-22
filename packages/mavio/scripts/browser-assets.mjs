#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
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

export async function prepareBrowserAssets(destination, consumerDirectory = process.cwd()) {
  const consumer = createRequire(join(resolve(consumerDirectory), "package.json"));
  const sdk = createRequire(import.meta.url);
  const coreDirectory = join(dirname(dirname(consumer.resolve("@ffmpeg/core"))), "esm");
  const wrapperDirectory = dirname(sdk.resolve("@ffmpeg/ffmpeg/worker"));
  const wrapperMetadata = JSON.parse(
    await readFile(join(wrapperDirectory, "../../package.json"), "utf8"),
  );
  assert.equal(wrapperMetadata.version, "0.12.15", "Unsupported FFmpeg wrapper.");
  const core = await readFile(join(coreDirectory, "ffmpeg-core.js"));
  const wasm = await readFile(join(coreDirectory, "ffmpeg-core.wasm"));
  assert.equal(sha256(wasm), CORE_WASM_SHA256, "Unsupported core WASM.");
  const patched = patchBrowserCore(core);
  const files = new Map([
    ["ffmpeg-core.js", patched],
    ["ffmpeg-core.wasm", wasm],
  ]);
  for (const name of await readdir(wrapperDirectory)) {
    if (name.endsWith(".js"))
      files.set(`wrapper/${name}`, await readFile(join(wrapperDirectory, name)));
  }
  const manifest = {
    wrapperVersion: "0.12.15",
    coreVersion: "0.12.10",
    correction: "restore-stack-after-native-entry-v1",
    files: Object.fromEntries([...files].map(([name, data]) => [name, sha256(data)])),
  };
  // Require a new destination; never overwrite application files.
  await mkdir(destination, { recursive: false });
  await mkdir(join(destination, "wrapper"));
  for (const [name, data] of files) await writeFile(join(destination, name), data, { flag: "wx" });
  await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2), {
    flag: "wx",
  });
  return manifest;
}

// npm uses a symlink in node_modules/.bin on POSIX.
if (
  process.argv[1] &&
  (await realpath(resolve(process.argv[1])).catch(() => undefined)) ===
    (await realpath(fileURLToPath(import.meta.url)))
) {
  if (process.argv.length !== 3) {
    console.error(
      "Usage: mavio-browser-assets <new-output-directory> (install @ffmpeg/core@0.12.10 in the application first)",
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
