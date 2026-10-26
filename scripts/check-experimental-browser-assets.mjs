import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, cp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [coreDirectory, sourceArchive, noticeDirectory, suppliedCli] = process.argv.slice(2);
assert.ok(
  coreDirectory && sourceArchive && noticeDirectory,
  "Usage: node scripts/check-experimental-browser-assets.mjs <core-directory> <source-archive> <notice-directory> [installed-cli-path]",
);

const cli = resolve(suppliedCli ?? "packages/mavio/scripts/browser-assets-experimental.mjs");
const { prepareExperimentalBrowserAssets } = await import(pathToFileURL(cli).href);
const { patchCandidateBrowserCore } = await import(
  pathToFileURL(join(dirname(cli), "experimental-core.mjs")).href
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = await mkdtemp(join(tmpdir(), "mavio-experimental-cli-check-"));
let checks = 0;

async function absent(path) {
  await assert.rejects(stat(path), { code: "ENOENT" });
}

async function rejectsBeforeCreation(name, core, source, notices, pattern) {
  const destination = join(root, name);
  await assert.rejects(
    prepareExperimentalBrowserAssets(destination, core, source, notices),
    pattern,
  );
  await absent(destination);
  checks++;
}

const invalidCore = join(root, "invalid-core");
await mkdir(invalidCore);
await writeFile(join(invalidCore, "ffmpeg-core.js"), "invalid");
await writeFile(join(invalidCore, "ffmpeg-core.wasm"), "invalid");
await rejectsBeforeCreation(
  "reject-core",
  invalidCore,
  sourceArchive,
  noticeDirectory,
  /hash mismatch/i,
);

const invalidSource = join(root, "invalid-source.tar.gz");
await writeFile(invalidSource, "invalid");
await rejectsBeforeCreation(
  "reject-source",
  coreDirectory,
  invalidSource,
  noticeDirectory,
  /source archive hash mismatch/i,
);

const invalidNotices = join(root, "invalid-notices");
await cp(noticeDirectory, invalidNotices, { recursive: true, errorOnExist: true, force: false });
const pins = JSON.parse(await readFile(join(dirname(cli), "experimental-core-pins.json"), "utf8"));
assert.ok(pins.notices.length > 0);
await writeFile(join(invalidNotices, pins.notices[0].file), "invalid");
await rejectsBeforeCreation(
  "reject-notice",
  coreDirectory,
  sourceArchive,
  invalidNotices,
  /notice hash mismatch/i,
);

const destination = join(root, "engine");
const manifest = await prepareExperimentalBrowserAssets(
  destination,
  coreDirectory,
  sourceArchive,
  noticeDirectory,
);
assert.equal(manifest.status, "experimental-unaccepted");
assert.equal(manifest.sourceArchiveSha256, sha256(await readFile(sourceArchive)));

for (const [name, expected] of Object.entries(manifest.files)) {
  assert.equal(sha256(await readFile(join(destination, name))), expected, name);
}
assert.deepEqual(
  await readFile(join(destination, "ffmpeg-core.js")),
  patchCandidateBrowserCore(await readFile(join(coreDirectory, "ffmpeg-core.js"))),
);
assert.deepEqual(
  await readFile(join(destination, "ffmpeg-core.wasm")),
  await readFile(join(coreDirectory, "ffmpeg-core.wasm")),
);
assert.deepEqual(JSON.parse(await readFile(join(destination, "manifest.json"), "utf8")), manifest);
for (const name of [
  "sources/mavio-experimental-core-sources.tar.gz",
  "notices/ffmpegwasm-wrapper-MIT.txt",
  "wrapper/worker.js",
  "ENGINE-LICENSING.md",
]) {
  assert.ok(Object.hasOwn(manifest.files, name), "Missing manifest entry: " + name);
}
checks++;

const sentinel = join(destination, "caller-owned.txt");
await writeFile(sentinel, "preserve");
await assert.rejects(
  prepareExperimentalBrowserAssets(destination, coreDirectory, sourceArchive, noticeDirectory),
  { code: "EEXIST" },
);
assert.equal(await readFile(sentinel, "utf8"), "preserve");
assert.deepEqual(JSON.parse(await readFile(join(destination, "manifest.json"), "utf8")), manifest);
checks++;

console.log("PASS: " + checks + " experimental generation and rejection checks.");
console.log("EXPERIMENTAL_TEST_ASSETS=" + destination);
