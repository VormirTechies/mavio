import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const sdkRequire = createRequire(new URL("../packages/mavio/package.json", import.meta.url));
const rootRequire = createRequire(new URL("../package.json", import.meta.url));

async function packageRoot(name, resolver) {
  let directory = dirname(resolver.resolve(name));

  while (true) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));

      if (metadata.name === name) return { directory, metadata };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate ${name}.`);
    directory = parent;
  }
}

async function main() {
  const wrapper = await packageRoot("@ffmpeg/ffmpeg", sdkRequire);
  const core = await packageRoot("@ffmpeg/core", rootRequire);

  assert.equal(wrapper.metadata.version, "0.12.15");
  assert.equal(core.metadata.version, "0.12.10");

  const assets = new Map();

  assets.set("/", {
    type: "text/html; charset=utf-8",
    body: Buffer.from(
      '<!doctype html><html><head><link rel="icon" href="data:,">' +
        "<title>Mavio browser engine check</title></head>" +
        "<body>Mavio browser engine check</body></html>",
    ),
  });

  assets.set("/smoke.mjs", {
    type: "text/javascript; charset=utf-8",
    body: await readFile(new URL("./browser-engine-smoke.mjs", import.meta.url)),
  });

  const wrapperDirectory = join(wrapper.directory, "dist", "esm");

  for (const name of await readdir(wrapperDirectory)) {
    if (!name.endsWith(".js")) continue;

    assets.set(`/wrapper/${name}`, {
      type: "text/javascript; charset=utf-8",
      body: await readFile(join(wrapperDirectory, name)),
    });
  }

  for (const name of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
    assets.set(`/core/${name}`, {
      type: name.endsWith(".wasm") ? "application/wasm" : "text/javascript; charset=utf-8",
      body: await readFile(join(core.directory, "dist", "esm", name)),
    });
  }

  const missingRequests = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    const asset = assets.get(path);

    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Cache-Control", "no-store");

    if (!asset) {
      missingRequests.push(path);
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.setHeader("Content-Type", asset.type);
    response.writeHead(200);
    response.end(asset.body);
  });

  let browser;
  let timer;

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({
      headless: true,
      channel: process.env.MAVIO_BROWSER_CHANNEL || undefined,
      timeout: 60_000,
    });

    const page = await browser.newPage();
    const pageErrors = [];

    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(origin, {
      waitUntil: "load",
      timeout: 30_000,
    });

    const result = await Promise.race([
      page.evaluate(async (baseURL) => {
        const { runBrowserEngineSmoke } = await import("/smoke.mjs");
        return runBrowserEngineSmoke(baseURL);
      }, origin),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Browser engine smoke test timed out.")),
          180_000,
        );
      }),
    ]);

    assert.deepEqual(missingRequests, [], "Missing hosted engine assets.");
    assert.deepEqual(pageErrors, [], "Unexpected browser page errors.");

    console.table(result);
    console.log("Same-origin browser worker and WASM initialization passed.");
    console.log("Browser WAV encoding and structured metadata probing passed.");
    console.log("Invalid-media rejection and same-worker recovery passed.");
    console.log("Worker termination and clean reload passed.");
    console.log("Returned bytes remain valid after worker termination.");
    console.log("Public Mavio browser integration and active-job cancellation are not covered.");
  } finally {
    clearTimeout(timer);

    try {
      if (browser) await browser.close();
    } finally {
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
          server.closeAllConnections();
        });
      }
    }
  }
}

try {
  await main();
} catch (error) {
  console.error("Browser engine smoke test failed.");
  console.error(error);
  process.exitCode = 1;
}
