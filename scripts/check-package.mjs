import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;

assert.ok(npmCli, "Run this script through npm run test:package.");

const consumerDir = mkdtempSync(path.join(tmpdir(), "mavio-package-"));

function npm(args, cwd = root) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

console.log(`Consumer directory: ${consumerDir}`);

const [packed] = JSON.parse(
  npm([
    "pack",
    "--workspace=@vormir/mavio",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    consumerDir,
  ]),
);

const files = new Set(packed.files.map((file) => file.path));

for (const required of [
  "package.json",
  "LICENSE",
  "README.md",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/browser.js",
  "dist/browser.d.ts",
  "dist/node.js",
  "dist/node.d.ts",
  "dist/contracts.d.ts",
]) {
  assert.ok(files.has(required), `Missing package file: ${required}`);
}

writeFileSync(
  path.join(consumerDir, "package.json"),
  JSON.stringify({
    name: "mavio-package-consumer",
    private: true,
    type: "module",
  }),
);

npm(
  [
    "install",
    path.join(consumerDir, packed.filename),
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ],
  consumerDir,
);

const consumerCode = `
  import assert from "node:assert/strict";

  for (const entry of [
    "@vormir/mavio",
    "@vormir/mavio/browser",
    "@vormir/mavio/node"
  ]) {
    const sdk = await import(entry);
    assert.equal(sdk.SDK_VERSION, ${JSON.stringify(packed.version)});
  }

  console.log("Packaged imports passed");
`;

execFileSync(process.execPath, ["--input-type=module", "-e", consumerCode], {
  cwd: consumerDir,
  stdio: "inherit",
  windowsHide: true,
});

execFileSync(process.execPath, [path.join(root, "scripts/check-browser-bundle.mjs"), consumerDir], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});

console.log("Package verification passed");
