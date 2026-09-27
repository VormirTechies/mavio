import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"));

test("all public entry points expose the package version", async () => {
  for (const entry of ["@vormir/mavio", "@vormir/mavio/browser", "@vormir/mavio/node"]) {
    const sdk = await import(entry);
    assert.equal(sdk.SDK_VERSION, manifest.version);
  }
});

test("Node selects the Node entry point", () => {
  assert.equal(import.meta.resolve("@vormir/mavio"), import.meta.resolve("@vormir/mavio/node"));
});

test("the browser condition selects the browser entry point", () => {
  const resolved = execFileSync(
    process.execPath,
    [
      "--conditions=browser",
      "--input-type=module",
      "-e",
      "console.log(import.meta.resolve('@vormir/mavio'))",
    ],
    {
      cwd: fileURLToPath(packageRoot),
      encoding: "utf8",
      windowsHide: true,
    },
  ).trim();

  assert.equal(resolved, import.meta.resolve("@vormir/mavio/browser"));
});
