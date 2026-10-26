#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./browser-assets.mjs";
import { patchCandidateBrowserCore, verifyCandidateCoreAsset } from "./experimental-core.mjs";

export async function prepareExperimentalBrowserAssets(
  destination,
  coreDirectory,
  sourceArchive,
  noticeDirectory,
) {
  const pins = JSON.parse(
    await readFile(new URL("./experimental-core-pins.json", import.meta.url), "utf8"),
  );
  assert.equal(pins.status, "experimental-unaccepted");

  const core = await readFile(join(coreDirectory, "ffmpeg-core.js"));
  const wasm = await readFile(join(coreDirectory, "ffmpeg-core.wasm"));
  verifyCandidateCoreAsset("ffmpeg-core.js", core);
  verifyCandidateCoreAsset("ffmpeg-core.wasm", wasm);
  const patched = patchCandidateBrowserCore(core);

  const sources = await readFile(sourceArchive);
  assert.equal(
    sha256(sources),
    pins.sourceArchiveSha256,
    "Experimental source archive hash mismatch.",
  );

  const files = new Map([
    ["ffmpeg-core.js", patched],
    ["ffmpeg-core.wasm", wasm],
    ["sources/mavio-experimental-core-sources.tar.gz", sources],
  ]);

  for (const notice of pins.notices) {
    assert.match(notice.file, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
    const bytes = await readFile(join(noticeDirectory, notice.file));
    assert.equal(sha256(bytes), notice.sha256, "Experimental notice hash mismatch: " + notice.file);
    const target = "notices/" + notice.file;
    assert.ok(!files.has(target), "Duplicate experimental notice.");
    files.set(target, bytes);
  }

  const sdk = createRequire(import.meta.url);
  const wrapperDirectory = dirname(sdk.resolve("@ffmpeg/ffmpeg/worker"));
  const wrapperMetadata = JSON.parse(
    await readFile(join(wrapperDirectory, "../../package.json"), "utf8"),
  );
  assert.equal(wrapperMetadata.version, "0.12.15", "Unsupported FFmpeg wrapper.");
  const wrapperNames = (await readdir(wrapperDirectory))
    .filter((name) => name.endsWith(".js"))
    .sort();

  for (const required of ["index.js", "classes.js", "worker.js"]) {
    assert.ok(wrapperNames.includes(required), "Missing wrapper module: " + required);
  }
  for (const name of wrapperNames) {
    files.set("wrapper/" + name, await readFile(join(wrapperDirectory, name)));
  }
  files.set(
    "notices/ffmpegwasm-wrapper-MIT.txt",
    await readFile(new URL("../third-party/ffmpegwasm-MIT.txt", import.meta.url)),
  );

  const guide = [
    "# Experimental Mavio Browser engine",
    "",
    "Candidate: " + pins.candidateId,
    "",
    "This opt-in output is experimental and is not release-approved.",
    "M7-D01 and M7-L01 remain open. Notice collection does not establish complete licensing clearance.",
    "",
    "The JavaScript binding restores the stack after both native entry points.",
    "The candidate WASM is copied unchanged.",
    "The source archive includes pinned component sources, runtime source material,",
    "build recipes, and the recorded maintenance and security modifications.",
    "",
    "Preserve notices/ and sources/ with this deployment output.",
    "The source archive is sources/mavio-experimental-core-sources.tar.gz.",
    "Follow SOURCE-BUNDLE.md inside that archive for reconstruction instructions.",
    "",
    "The x264 initialization-cleanup finding remains open.",
    "Worker termination on encoding failure is a containment measure, not an x264 fix.",
    "No public publication, production adoption, or security exception is authorized by generation.",
    "",
  ].join("\n");
  files.set("ENGINE-LICENSING.md", Buffer.from(guide));

  const manifest = {
    status: "experimental-unaccepted",
    candidateId: pins.candidateId,
    wrapperVersion: "0.12.15",
    ffmpegVersion: "5.1.10",
    correction: "restore-stack-after-native-entry-v1",
    sourceArchiveSha256: pins.sourceArchiveSha256,
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)])),
  };

  // Validate and read every supplied input before claiming a fresh destination.
  await mkdir(destination, { recursive: false });
  for (const directory of ["wrapper", "notices", "sources"]) {
    await mkdir(join(destination, directory));
  }
  for (const [name, bytes] of files) {
    await writeFile(join(destination, name), bytes, { flag: "wx" });
  }
  await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
  });
  return manifest;
}

if (
  process.argv[1] &&
  (await realpath(resolve(process.argv[1])).catch(() => undefined)) ===
    (await realpath(fileURLToPath(import.meta.url)))
) {
  if (process.argv.length !== 6) {
    console.error(
      "Usage: mavio-browser-assets-experimental <new-output-directory> <candidate-core-directory> <source-archive> <notice-directory>",
    );
    process.exitCode = 1;
  } else {
    try {
      const manifest = await prepareExperimentalBrowserAssets(
        ...process.argv.slice(2).map((value) => resolve(value)),
      );
      console.log(JSON.stringify(manifest, null, 2));
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }
}
