import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
import path from "node:path";
import { build } from "esbuild";

const consumerDir = process.argv[2];
assert.ok(consumerDir, "Provide the temporary consumer directory.");

const resolveDir = path.resolve(consumerDir);

assert.ok(
  existsSync(path.join(resolveDir, "node_modules/@vormir/mavio/package.json")),
  "The consumer directory must contain the installed Mavio archive.",
);

const result = await build({
  stdin: {
    contents: 'export { SDK_VERSION, createMavio } from "@vormir/mavio";',
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

const inputs = Object.keys(result.metafile.inputs).map((file) => file.replaceAll("\\", "/"));

assert.ok(
  inputs.some((file) => file.endsWith("/@vormir/mavio/dist/browser.js")),
  "The bundle must use Mavio's browser entry.",
);

assert.ok(
  !inputs.some((file) => file.endsWith("/@vormir/mavio/dist/node.js")),
  "The bundle must exclude Mavio's Node entry.",
);

for (const output of Object.values(result.metafile.outputs)) {
  assert.equal(output.imports.length, 0, "The current foundation bundle must be self-contained.");
}

console.log("Browser bundle passed");
console.log("Inputs:", inputs);

const installedPackage = JSON.parse(
  readFileSync(path.join(resolveDir, "node_modules/@vormir/mavio/package.json"), "utf8"),
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
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));

    try {
      const sdk = await import(url);
      const calls = [];

      const engine = {
        id: "browser-package-smoke",
        runtime: "browser",

        async initialize() {
          calls.push("initialize");
        },

        async capabilities() {
          calls.push("capabilities");

          return {
            engineId: "browser-package-smoke",
            engineVersion: "test",
            runtime: "browser",
            operations: ["metadata"],
            inputKinds: ["bytes"],
            outputKinds: ["bytes"],
            readableContainers: [],
            decoders: [],
            encodings: [],
            limits: {},
          };
        },

        async probe() {
          calls.push("probe");
          return { durationSeconds: 2, streams: [] };
        },

        async supports() {
          return { status: "supported" };
        },

        async execute() {
          throw new Error("Unexpected execution.");
        },

        async dispose() {
          calls.push("dispose");
        },
      };

      const client = sdk.createMavio({ engine });

      try {
        if (calls.length !== 0) {
          throw new Error("Factory initialized the engine eagerly.");
        }

        const metadata = await client
          .from({ kind: "bytes", bytes: new Uint8Array([1]) })
          .metadata();

        if (metadata.durationSeconds !== 2) {
          throw new Error("Browser metadata result did not match.");
        }
      } finally {
        await client.dispose();
      }

      if (calls.join(",") !== "initialize,capabilities,probe,dispose") {
        throw new Error(`Unexpected browser lifecycle: ${calls.join(",")}`);
      }

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
