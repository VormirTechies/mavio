import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [suppliedKit, suppliedGenerator] = process.argv.slice(2);
assert.ok(suppliedKit, "Provide an engine-kit directory.");
const kit = resolve(suppliedKit);
const generator = resolve(suppliedGenerator ?? "packages/mavio/scripts/browser-assets.mjs");
const { prepareBrowserAssets } = await import(pathToFileURL(generator).href);
const pins = JSON.parse(
  await readFile(join(dirname(generator), "browser-engine-kit-pins.json"), "utf8"),
);
const root = join(dirname(kit), "kit-verification-" + randomUUID());
await mkdir(root);
const fixture = join(root, "altered-kit");
await cp(kit, fixture, { recursive: true, errorOnExist: true, force: false });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let passed = 0;

async function generate(destination, selectedKit) {
  const previous = process.env.MAVIO_BROWSER_ENGINE_KIT;
  process.env.MAVIO_BROWSER_ENGINE_KIT = selectedKit;
  try {
    return await prepareBrowserAssets(destination);
  } finally {
    if (previous === undefined) delete process.env.MAVIO_BROWSER_ENGINE_KIT;
    else process.env.MAVIO_BROWSER_ENGINE_KIT = previous;
  }
}

async function rejectAlteration(relative, replacement, pattern) {
  const file = join(fixture, relative);
  const original = await readFile(file);
  const destination = join(root, "rejected-" + passed);
  try {
    await writeFile(file, replacement);
    await assert.rejects(generate(destination, fixture), pattern);
    await assert.rejects(stat(destination), { code: "ENOENT" });
    passed++;
  } finally {
    await writeFile(file, original);
  }
}

await rejectAlteration("engine-kit.json", "{}", /Unsupported Browser engine kit manifest/);
await rejectAlteration("core/ffmpeg-core.wasm", "invalid", /hash mismatch/);
await rejectAlteration("sources/mavio-candidate-v2-sources.tar.gz", "invalid", /hash mismatch/);
const notice = Object.keys(pins.files).find((name) => name.startsWith("notices/"));
assert.ok(notice);
await rejectAlteration(notice, "invalid", /hash mismatch/);

const destination = join(root, "engine");
const manifest = await generate(destination, kit);
assert.equal(manifest.candidateId, pins.candidateId);
assert.equal(manifest.files["ffmpeg-core.wasm"], pins.files["core/ffmpeg-core.wasm"]);
for (const [name, expected] of Object.entries(manifest.files)) {
  assert.equal(sha256(await readFile(join(destination, name))), expected, name);
}
assert.deepEqual(JSON.parse(await readFile(join(destination, "manifest.json"), "utf8")), manifest);
for (const name of Object.keys(pins.files).filter((name) => !name.startsWith("core/"))) {
  assert.equal(manifest.files[name], pins.files[name], name);
}
passed++;

const sentinel = join(destination, "caller-owned.txt");
await writeFile(sentinel, "preserve");
await assert.rejects(generate(destination, kit), { code: "EEXIST" });
assert.equal(await readFile(sentinel, "utf8"), "preserve");
passed++;

console.log("PASS: " + passed + " kit generation and rejection checks.");
console.log("VERIFIED_KIT_ASSETS=" + destination);
