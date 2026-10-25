import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const recipe = fileURLToPath(new URL("./", import.meta.url));
const destination = process.argv[2];
assert.ok(destination && isAbsolute(destination), "Provide a new absolute destination.");
const pins = JSON.parse(await readFile(join(recipe, "sources.json"), "utf8"));

function git(directory, args, capture = false) {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, capture ? result.stderr : "Git command failed.");
  return capture ? result.stdout.trim() : undefined;
}

// Refuse to reuse an existing directory.
await mkdir(destination, { recursive: false });

for (const source of Object.values(pins.sources)) {
  assert.match(source.repository, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/);
  assert.match(source.commit, /^[a-f0-9]{40}$/);
  assert.match(source.directory, /^[a-zA-Z0-9-]+$/);

  const directory = join(destination, source.directory);
  await mkdir(directory);
  git(directory, ["init"]);
  git(directory, ["config", "core.autocrlf", "false"]);
  git(directory, ["remote", "add", "origin", source.repository]);
  git(directory, ["fetch", "--depth=1", "origin", source.commit]);
  git(directory, ["checkout", "--detach", "FETCH_HEAD"]);
  assert.equal(git(directory, ["rev-parse", "HEAD"], true), source.commit);
  assert.equal(git(directory, ["status", "--porcelain"], true), "");
}

const maintenancePath = join(recipe, "fftools-maintenance.patch");
const maintenance = await readFile(maintenancePath);
assert.equal(
  createHash("sha256").update(maintenance).digest("hex"),
  pins.commandLineMaintenancePatchSHA256,
);

const bindings = join(destination, pins.sources.bindings.directory);
git(bindings, ["apply", "--check", "--directory=src", maintenancePath]);
git(bindings, ["apply", "--directory=src", maintenancePath]);

const zlibPatch = await readFile(join(recipe, pins.zlibSecurityPatch.file));
assert.equal(createHash("sha256").update(zlibPatch).digest("hex"), pins.zlibSecurityPatch.sha256);

const x264Patch = await readFile(join(recipe, pins.x264CleanupPatch.file));
assert.equal(createHash("sha256").update(x264Patch).digest("hex"), pins.x264CleanupPatch.sha256);

// Docker applies both dependency patches and the runtime-export changes.
for (const name of [
  "Dockerfile",
  ".dockerignore",
  "build.sh",
  "export-stack-runtime.sh",
  "sources.json",
  "stack-runtime-exports.json",
  "fftools-maintenance.patch",
  "zlib-CVE-2026-85091.patch",
  "zlib-security-patch.json",
  "x264-initialization-param-cleanup.patch",
]) {
  await copyFile(join(recipe, name), join(destination, name));
}

console.log("PASS: Pinned sources prepared; maintenance patch applied.");
console.log("PREPARED_BUILD_CONTEXT=" + destination);
console.log("Experimental only; no build, adoption, or publication performed.");
