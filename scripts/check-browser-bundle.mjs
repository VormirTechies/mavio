import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
import path from "node:path";
import { build } from "esbuild";

const consumerDir = process.argv[2];
assert.ok(consumerDir, "Provide the temporary consumer directory.");

const resolveDir = path.resolve(consumerDir);

assert.ok(
  existsSync(
    path.join(resolveDir, "node_modules/@vormir/mavio/package.json"),
  ),
  "The consumer directory must contain the installed Mavio archive.",
);

const result = await build({
  stdin: {
    contents: 'export { SDK_VERSION } from "@vormir/mavio";',
    resolveDir,
    sourcefile: "consumer.js",
    loader: "js",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  conditions: ["browser"],
  metafile: true,
  write: false,
});

const inputs = Object.keys(result.metafile.inputs).map((file) =>
  file.replaceAll("\\", "/"),
);

assert.ok(
  inputs.some((file) =>
    file.endsWith("/@vormir/mavio/dist/browser.js"),
  ),
  "The bundle must use Mavio's browser entry.",
);

assert.ok(
  !inputs.some((file) =>
    file.endsWith("/@vormir/mavio/dist/node.js"),
  ),
  "The bundle must exclude Mavio's Node entry.",
);

for (const output of Object.values(result.metafile.outputs)) {
  assert.equal(
    output.imports.length,
    0,
    "The current foundation bundle must be self-contained.",
  );
}

console.log("Browser bundle passed");
console.log("Inputs:", inputs);

const installedPackage = JSON.parse(
  readFileSync(
    path.join(resolveDir, "node_modules/@vormir/mavio/package.json"),
    "utf8",
  ),
);

const browser = await chromium.launch({ 
    headless: true, 
    channel: process.env.MAVIO_BROWSER_CHANNEL || undefined,
});

try {
  const page = await browser.newPage();
  const pageErrors = [];

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const version = await page.evaluate(async (source) => {
    const url = URL.createObjectURL(
      new Blob([source], { type: "text/javascript" }),
    );

    try {
      const sdk = await import(url);
      return sdk.SDK_VERSION;
    } finally {
      URL.revokeObjectURL(url);
    }
  }, result.outputFiles[0].text);

  assert.equal(version, installedPackage.version);
  assert.deepEqual(pageErrors, []);

  console.log(`Chromium runtime passed: ${version}`);
} finally {
  await browser.close();
}