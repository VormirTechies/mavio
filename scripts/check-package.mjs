import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  "scripts/browser-assets.mjs",
  "scripts/browser-assets-kit.mjs",
  "scripts/browser-engine-kit-pins.json",
  "scripts/experimental-core.mjs",
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

if (process.env.MAVIO_PACKAGE_BROWSER === "1") {
  // The browser application supplies the separately hosted core assets.
  npm(
    [
      "install",
      "--save-dev",
      "--save-exact",
      "@ffmpeg/core@0.12.10",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    consumerDir,
  );

  const selectedKit = process.env.MAVIO_BROWSER_ENGINE_KIT;
  const kitPins = selectedKit
    ? JSON.parse(
        readFileSync(
          path.join(root, "packages/mavio/scripts/browser-engine-kit-pins.json"),
          "utf8",
        ),
      )
    : undefined;
  const expectedCoreWasm = kitPins
    ? kitPins.files["core/ffmpeg-core.wasm"]
    : "9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7";
  const assetDirectory = path.join(consumerDir, "browser-assets");
  const generated = JSON.parse(
    npm(["exec", "--no", "--", "mavio-browser-assets", assetDirectory], consumerDir),
  );
  assert.equal(generated.correction, "restore-stack-after-native-entry-v1");
  assert.equal(generated.files["ffmpeg-core.wasm"], expectedCoreWasm);
  if (kitPins) {
    assert.equal(generated.candidateId, kitPins.candidateId);
    for (const [name, expected] of Object.entries(kitPins.files)) {
      if (!name.startsWith("core/")) assert.equal(generated.files[name], expected, name);
    }
    execFileSync(
      process.execPath,
      [
        path.join(root, "scripts/check-browser-engine-kit.mjs"),
        selectedKit,
        path.join(consumerDir, "node_modules/@vormir/mavio/scripts/browser-assets.mjs"),
      ],
      {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
      },
    );
  }
  console.log(`Installed asset CLI passed: ${assetDirectory}`);

  execFileSync(process.execPath, [path.join(root, "scripts/check-browser-verified.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MAVIO_BROWSER_CONSUMER_DIR: consumerDir,
      MAVIO_BROWSER_ASSET_DIR: assetDirectory,
    },
    stdio: "inherit",
    windowsHide: true,
  });

  console.log("Installed-package public browser route verification passed.");
}

console.log("Package verification passed");
