import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const [archiveArgument, destination] = process.argv.slice(2);
assert.ok(archiveArgument && destination && isAbsolute(destination));
assert.ok(!/[\r\n]/.test(destination));

const archive = resolve(archiveArgument);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const record = JSON.parse(
  await readFile(
    new URL("../docs/releases/m8-engine-distribution-0.0.3.json", import.meta.url),
    "utf8",
  ),
);
const bytes = await readFile(archive);
assert.equal(bytes.length, record.sizeBytes);
assert.equal(hash(bytes), record.archiveSha256, "Distribution archive hash mismatch.");

const executable =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

function tar(args) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

for (const member of tar(["-tf", archive]).split(/\r?\n/).filter(Boolean)) {
  assert.ok(!/^[\\/]|^[a-z]:/i.test(member));
  assert.ok(!member.split(/[\\/]/).includes(".."));
}

await mkdir(destination, { recursive: false });
tar(["-xf", archive, "-C", destination]);

const manifestBytes = await readFile(join(destination, "distribution-manifest.json"));
assert.equal(hash(manifestBytes), record.distributionManifestSha256);
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.sdkVersion, record.sdkVersion);
assert.equal(manifest.candidateId, record.candidateId);

const actual = [];
async function walk(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await walk(join(directory, entry.name), name + "/");
    else {
      assert.ok(entry.isFile(), "Unexpected entry: " + name);
      actual.push(name);
    }
  }
}
await walk(destination);
assert.deepEqual(
  actual.sort(),
  [...Object.keys(manifest.files), "distribution-manifest.json"].sort(),
);
assert.equal(actual.length, record.extractedFiles);

for (const [name, expected] of Object.entries(manifest.files)) {
  assert.ok(!/^[\\/]|^[a-z]:/i.test(name));
  assert.ok(!name.split(/[\\/]/).includes(".."));
  assert.equal(hash(await readFile(join(destination, name))), expected, name);
}

const kit = join(destination, "engine-kit");
const pins = JSON.parse(
  await readFile(
    new URL("../packages/mavio/scripts/browser-engine-kit-pins.json", import.meta.url),
    "utf8",
  ),
);
assert.deepEqual(JSON.parse(await readFile(join(kit, "engine-kit.json"), "utf8")), pins);
for (const [name, expected] of Object.entries(pins.files)) {
  assert.equal(hash(await readFile(join(kit, name))), expected, name);
}
assert.equal(
  hash(await readFile(join(destination, "supplemental-notices/musl-EMBEDDED-NOTICES.txt"))),
  "b5232f66df00649302711c709e4d2d07467457e8af32a492b2292e638d378e0a",
);

if (process.env.GITHUB_ENV) {
  await appendFile(
    process.env.GITHUB_ENV,
    [
      "MAVIO_BROWSER_ENGINE_KIT=" + kit,
      "MAVIO_REPLAY_CANDIDATE_PROFILE=v2",
      "MAVIO_REPLAY_CANDIDATE_CORE_DIR=" + join(kit, "core"),
      "",
    ].join("\n"),
  );
}
console.log("PASS: Release distribution, complete file inventory, and engine pins verified.");
console.log("MAVIO_BROWSER_ENGINE_KIT=" + kit);
