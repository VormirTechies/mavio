import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

const [archive, destination] = process.argv.slice(2);
assert.ok(archive && destination && isAbsolute(destination));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = await readFile(archive);
assert.equal(bytes.length, 51321159);
assert.equal(hash(bytes), "d3716527590fa75336f7e1234bb097fd1b87523b17996c052981f1dd862cb838");

// Git Bash tar treats Windows drive letters as remote-host syntax.
const tarExecutable =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

function tar(args) {
  const result = spawnSync(tarExecutable, args, {
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

const pins = JSON.parse(
  await readFile(
    new URL("../packages/mavio/scripts/browser-engine-kit-pins.json", import.meta.url),
    "utf8",
  ),
);
assert.deepEqual(JSON.parse(await readFile(join(destination, "engine-kit.json"), "utf8")), pins);
for (const [name, expected] of Object.entries(pins.files)) {
  assert.match(name, /^(core|notices|sources)\/[a-zA-Z0-9._-]+$/);
  assert.equal(hash(await readFile(join(destination, name))), expected, name);
}
if (process.env.GITHUB_ENV) {
  assert.ok(!/[\r\n]/.test(destination));
  await appendFile(
    process.env.GITHUB_ENV,
    [
      "MAVIO_BROWSER_ENGINE_KIT=" + destination,
      "MAVIO_REPLAY_CANDIDATE_PROFILE=v2",
      "MAVIO_REPLAY_CANDIDATE_CORE_DIR=" + join(destination, "core"),
      "",
    ].join("\n"),
  );
}
console.log("PASS: CI v2 archive and all kit files verified; explicit selection configured.");
