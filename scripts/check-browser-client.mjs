import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { tmpdir } from "node:os";

const consumerDirectory = process.env.MAVIO_BROWSER_CONSUMER_DIR
  ? resolve(process.env.MAVIO_BROWSER_CONSUMER_DIR)
  : undefined;

const sdkRequire = createRequire(
  consumerDirectory
    ? join(consumerDirectory, "package.json")
    : new URL("../packages/mavio/package.json", import.meta.url),
);

function withWorkerErrorStacks(source) {
  const marker = "data: e.toString(),";
  const first = source.indexOf(marker);

  assert.ok(first >= 0, "Pinned worker error handler was not found.");

  assert.equal(
    source.indexOf(marker, first + marker.length),
    -1,
    "Pinned worker error handler matched more than once.",
  );

  return source.replace(
    marker,
    String.raw`data: [
      String(e),
      "[mavio-wasm-debug] operation=" + String(type),
      "[mavio-wasm-debug] heapBytes=" +
        String(ffmpeg?.HEAPU8?.byteLength ?? "unavailable"),
      "[mavio-wasm-debug] args=" +
        JSON.stringify(_data?.args ?? []),
      "[mavio-wasm-debug] stack:\n" +
        String(e?.stack ?? "unavailable"),
    ].join("\n"),`,
  );
}

async function main() {
  const sdkEntry = consumerDirectory
    ? sdkRequire.resolve("@vormirtech/mavio/browser")
    : fileURLToPath(new URL("../packages/mavio/dist/browser.js", import.meta.url));
  // Use the asset correction shipped in the SDK being tested, including packs.
  const { prepareBrowserAssets } = await import(
    pathToFileURL(join(dirname(sdkEntry), "../scripts/browser-assets.mjs")).href
  );
  const preparedAssetDirectory = process.env.MAVIO_BROWSER_ASSET_DIR
    ? resolve(process.env.MAVIO_BROWSER_ASSET_DIR)
    : join(await mkdtemp(join(tmpdir(), "mavio-browser-assets-")), "engine");
  if (!process.env.MAVIO_BROWSER_ASSET_DIR) {
    await prepareBrowserAssets(
      preparedAssetDirectory,
      consumerDirectory ?? fileURLToPath(new URL("../", import.meta.url)),
    );
  }

  if (consumerDirectory) {
    assert.equal(
      await realpath(sdkEntry),
      await realpath(
        join(consumerDirectory, "node_modules", "@vormirtech", "mavio", "dist", "browser.js"),
      ),
      "Packaged verification must load the installed browser entry.",
    );

    console.log(`Installed browser SDK: ${sdkEntry}`);
  }

  const bundle = await build({
    entryPoints: [sdkEntry],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["browser"],
    write: false,
  });

  assert.equal(bundle.outputFiles.length, 1);

  const mp4Bundle = await build({
    entryPoints: [fileURLToPath(new URL("./browser-mp4-smoke.mjs", import.meta.url))],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    external: ["/wrapper/*", "/mavio.mjs"],
    write: false,
  });

  assert.equal(mp4Bundle.outputFiles.length, 1);

  const resizeBundle = await build({
    entryPoints: [fileURLToPath(new URL("./browser-resize-smoke.mjs", import.meta.url))],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    external: ["/mavio.mjs", "/wrapper/*"],
    write: false,
  });

  assert.equal(resizeBundle.outputFiles.length, 1);
  const audioBundle = await build({
    entryPoints: [fileURLToPath(new URL("./browser-audio-smoke.mjs", import.meta.url))],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    external: ["/wrapper/*", "/mavio.mjs"],
    write: false,
  });

  assert.equal(audioBundle.outputFiles.length, 1);

  const thumbnailBundle = await build({
    entryPoints: [fileURLToPath(new URL("./browser-thumbnail-smoke.mjs", import.meta.url))],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    external: ["/wrapper/*", "/mavio.mjs"],
    write: false,
  });

  assert.equal(thumbnailBundle.outputFiles.length, 1);

  const cancellationBundle = await build({
    entryPoints: [fileURLToPath(new URL("./browser-cancellation-smoke.mjs", import.meta.url))],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    external: ["/mavio.mjs"],
    write: false,
  });

  assert.equal(cancellationBundle.outputFiles.length, 1);

  const wrapperDirectory = join(preparedAssetDirectory, "wrapper");
  const coreDirectory = preparedAssetDirectory;

  const assets = new Map([
    [
      "/",
      {
        type: "text/html; charset=utf-8",
        body: Buffer.from(
          '<!doctype html><html><head><link rel="icon" href="data:,">' +
            "<title>Mavio client lifecycle</title></head>" +
            "<body>Mavio client lifecycle</body></html>",
        ),
      },
    ],
    [
      "/mavio.mjs",
      {
        type: "text/javascript; charset=utf-8",
        body: bundle.outputFiles[0].contents,
      },
    ],
  ]);

  assets.set("/mp4-smoke.mjs", {
    type: "text/javascript; charset=utf-8",
    body: mp4Bundle.outputFiles[0].contents,
  });

  assets.set("/resize-smoke.mjs", {
    type: "text/javascript; charset=utf-8",
    body: resizeBundle.outputFiles[0].contents,
  });

  assets.set("/audio-smoke.mjs", {
    type: "text/javascript; charset=utf-8",
    body: audioBundle.outputFiles[0].contents,
  });

  assets.set("/thumbnail-smoke.mjs", {
    type: "text/javascript; charset=utf-8",
    body: thumbnailBundle.outputFiles[0].contents,
  });

  assets.set("/cancellation-smoke.mjs", {
    type: "text/javascript; charset=utf-8",
    body: cancellationBundle.outputFiles[0].contents,
  });

  assets.set("/metadata-smoke.mjs", {
    type: "text/javascript; charset=utf-8",
    body: await readFile(new URL("./browser-metadata-smoke.mjs", import.meta.url)),
  });

  for (const name of await readdir(wrapperDirectory)) {
    if (!name.endsWith(".js")) continue;

    const original = await readFile(join(wrapperDirectory, name));

    const body =
      name === "worker.js"
        ? Buffer.from(withWorkerErrorStacks(original.toString("utf8")), "utf8")
        : original;

    assets.set(`/wrapper/${name}`, {
      type: "text/javascript; charset=utf-8",
      body,
    });
  }

  console.log("Diagnostic worker stack reporting enabled; installed assets unchanged.");

  for (const name of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
    const original = await readFile(join(coreDirectory, name));
    assets.set(`/core/${name}`, {
      type: name.endsWith(".wasm") ? "application/wasm" : "text/javascript; charset=utf-8",
      body: original,
    });
  }

  const requests = [];
  const missing = [];
  let retryCoreRequests = 0;
  const stalledDownloads = new Map();

  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    requests.push(path);

    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Cache-Control", "no-store");

    let assetPath = path;

    const stalled = stalledDownloads.get(path);

    if (stalled) {
      if (stalled.enabled) {
        stalled.hits += 1;
        stalled.responses.add(response);
        response.once("close", () => stalled.responses.delete(response));

        // Deliberately leave this download pending.
        return;
      }

      assetPath = "/core/ffmpeg-core.js";
    }

    if (path === "/retry/core.js") {
      retryCoreRequests += 1;

      if (retryCoreRequests === 1) {
        response.writeHead(503);
        response.end("Intentional first-load failure.");
        return;
      }

      assetPath = "/core/ffmpeg-core.js";
    }

    const asset = assets.get(assetPath);

    if (!asset) {
      missing.push(path);
      response.writeHead(404);
      response.end("Not found.");
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

    console.log(`Browser runtime: Chromium ${browser.version()}`);
    console.log(`Browser host: Node ${process.version}, ` + `${process.platform}/${process.arch}`);

    const page = await browser.newPage();

    await page.exposeFunction("__mavioSaveRegression", async (json) => {
      const destination = join(tmpdir(), "mavio-browser-regression.json");
      await writeFile(destination, json, "utf8");
      console.log(`[trim-debug] Regression trace saved: ${destination}`);
    });

    page.on("console", (message) => {
      const text = message.text();

      if (text.startsWith("[trim-debug]")) {
        console.log(text);
      }
    });

    const activeWorkers = new Set();
    const pageErrors = [];
    let workerCreations = 0;

    page.on("worker", (worker) => {
      workerCreations += 1;
      activeWorkers.add(worker);
      worker.on("close", () => activeWorkers.delete(worker));
    });

    page.on("pageerror", (error) => pageErrors.push(error.message));

    async function expectWorkers(count) {
      const deadline = Date.now() + 10_000;

      while (activeWorkers.size !== count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      assert.equal(activeWorkers.size, count, "Unexpected number of active browser workers.");
    }

    async function createClient(corePath, initTimeoutMs = 60_000) {
      await page.evaluate(
        async ({ baseURL, corePath, initTimeoutMs }) => {
          const { createMavio } = await import("/mavio.mjs");

          globalThis.__mavioLifecycleClient = createMavio({
            initTimeoutMs,
            browser: {
              assets: {
                coreURL: new URL(corePath, baseURL).href,
                wasmURL: new URL("/core/ffmpeg-core.wasm", baseURL).href,
                classWorkerURL: new URL("/wrapper/worker.js", baseURL).href,
              },
            },
          });
        },
        { baseURL: origin, corePath, initTimeoutMs },
      );
    }

    async function checkInterruptedInitialization(mode) {
      const path = `/interrupt/${mode}/core.js`;
      const stalled = {
        enabled: true,
        hits: 0,
        responses: new Set(),
      };

      stalledDownloads.set(path, stalled);

      const initialCreations = workerCreations;

      try {
        await createClient(path, mode === "timeout" ? 15_000 : 60_000);

        await page.evaluate(() => {
          const controller = new AbortController();

          globalThis.__mavioLifecycleAbort = controller;

          // Attach both handlers immediately so an expected failure
          // cannot become an unhandled rejection.
          globalThis.__mavioLifecycleOutcome = globalThis.__mavioLifecycleClient
            .capabilities({
              signal: controller.signal,
            })
            .then(
              () => ({ code: "UNEXPECTED_SUCCESS" }),
              (error) => ({
                code: error.code,
                reason: error.details?.reason,
              }),
            );
        });

        const downloadDeadline = Date.now() + 10_000;

        while (stalled.hits === 0 && Date.now() < downloadDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        assert.ok(
          stalled.hits > 0,
          `${mode}: the worker never requested the controlled core download.`,
        );

        await expectWorkers(1);
        assert.equal(workerCreations, initialCreations + 1);

        if (mode === "cancel") {
          await page.evaluate(() => {
            globalThis.__mavioLifecycleAbort.abort();
          });
        } else if (mode === "dispose") {
          await page.evaluate(() => globalThis.__mavioLifecycleClient.dispose());
        }

        const outcome = await page.evaluate(() => globalThis.__mavioLifecycleOutcome);

        assert.equal(outcome.code, mode === "timeout" ? "ENGINE_INIT_FAILED" : "CANCELLED");

        if (mode === "timeout") {
          assert.equal(outcome.reason, "TIMEOUT");
        }

        await expectWorkers(0);

        // Restore the URL only after proving worker cleanup.
        stalled.enabled = false;

        for (const response of stalled.responses) {
          response.destroy();
        }

        stalled.responses.clear();

        if (mode === "dispose") {
          const code = await page.evaluate(async () => {
            try {
              await globalThis.__mavioLifecycleClient.capabilities();
              return "UNEXPECTED_SUCCESS";
            } catch (error) {
              return error.code;
            }
          });

          assert.equal(code, "DISPOSED");
          assert.equal(workerCreations, initialCreations + 1);

          // Recovery after disposal requires a new client.
          await createClient(path);
        }

        const recovered = await page.evaluate(() =>
          globalThis.__mavioLifecycleClient.capabilities(),
        );

        assert.equal(recovered.runtime, "browser");
        assert.equal(workerCreations, initialCreations + 2);
        await expectWorkers(1);

        await page.evaluate(() => globalThis.__mavioLifecycleClient.dispose());

        await expectWorkers(0);

        if (mode === "timeout") {
          console.log(
            "Browser initialization timeout terminates its worker; same-client retry passes.",
          );
        } else if (mode === "cancel") {
          console.log(
            "Browser initialization cancellation terminates its worker; same-client retry passes.",
          );
        } else {
          console.log(
            "Disposal during browser initialization terminates its worker; a new client succeeds.",
          );
        }
      } finally {
        stalled.enabled = false;

        for (const response of stalled.responses) {
          response.destroy();
        }

        stalled.responses.clear();

        await page.evaluate(async () => {
          await globalThis.__mavioLifecycleClient?.dispose();
        });
      }
    }

    async function checks() {
      await page.goto(origin, { waitUntil: "load", timeout: 30_000 });

      await createClient("/core/ffmpeg-core.js");

      assert.equal(workerCreations, 0);
      assert.equal(
        requests.some((path) => path.startsWith("/core/") || path.startsWith("/wrapper/")),
        false,
        "Client construction fetched engine assets.",
      );

      await page.evaluate(async () => {
        await globalThis.__mavioLifecycleClient.dispose();
        await globalThis.__mavioLifecycleClient.dispose();
      });

      assert.equal(workerCreations, 0);
      console.log("Unused public browser client creates no worker.");

      await createClient("/core/ffmpeg-core.js");

      const capabilities = await page.evaluate(() =>
        globalThis.__mavioLifecycleClient.capabilities(),
      );

      assert.equal(capabilities.runtime, "browser");
      assert.equal(capabilities.engineId, "browser-ffmpeg");
      assert.equal(capabilities.engineVersion, "ffmpeg 5.1.10 (Mavio Browser core)");
      assert.deepEqual(capabilities.operations, [
        "metadata",
        "convert",
        "compress",
        "resize",
        "extractAudio",
        "trim",
        "thumbnail",
      ]);
      assert.deepEqual(capabilities.outputKinds, ["bytes", "blob"]);
      assert.deepEqual(capabilities.inputKinds, ["bytes", "blob"]);
      assert.deepEqual(
        capabilities.encodings.map((encoding) => encoding.preset),
        [
          "video-balanced-v1",
          "video-small-v1",
          "audio-balanced-v1",
          "audio-pcm-v1",
          "jpeg-balanced-v1",
          "png-lossless-v1",
        ],
      );

      assert.ok(
        capabilities.encodings
          .filter((encoding) => encoding.container === "mp4")
          .every(
            (encoding) =>
              encoding.audioCodec === "aac" && encoding.audioPadding === "decoder-dependent",
          ),
      );

      assert.ok(
        capabilities.readableContainers.includes("wav"),
        "The pinned browser core did not report the WAV demuxer.",
      );

      assert.ok(
        capabilities.decoders.includes("pcm_s16le"),
        "The pinned browser core did not report the PCM decoder.",
      );

      for (const names of [capabilities.readableContainers, capabilities.decoders]) {
        assert.deepEqual(names, [...new Set(names)].sort());
      }

      console.table({
        readableContainers: capabilities.readableContainers.length,
        decoders: capabilities.decoders.length,
      });

      console.log("Public browser capability inventory passed.");

      await expectWorkers(1);
      assert.equal(workerCreations, 1);

      const requestCount = requests.length;

      await page.evaluate(() =>
        Promise.all([
          globalThis.__mavioLifecycleClient.capabilities(),
          globalThis.__mavioLifecycleClient.capabilities(),
        ]),
      );

      assert.equal(workerCreations, 1);
      assert.equal(requests.length, requestCount);
      console.log("Public browser capabilities load and reuse one real worker.");

      const disposedCode = await page.evaluate(async () => {
        const client = globalThis.__mavioLifecycleClient;

        await client.dispose();
        await client.dispose();

        try {
          await client.capabilities();
          return "UNEXPECTED_SUCCESS";
        } catch (error) {
          return error.code;
        }
      });

      assert.equal(disposedCode, "DISPOSED");
      await expectWorkers(0);
      console.log("Public browser disposal closes the worker and rejects reuse.");

      await createClient("/retry/core.js");

      const failedCode = await page.evaluate(async () => {
        try {
          await globalThis.__mavioLifecycleClient.capabilities();
          return "UNEXPECTED_SUCCESS";
        } catch (error) {
          return error.code;
        }
      });

      assert.equal(failedCode, "ENGINE_INIT_FAILED");
      assert.equal(retryCoreRequests, 1);
      await expectWorkers(0);
      assert.equal(workerCreations, 2);

      const recovered = await page.evaluate(() => globalThis.__mavioLifecycleClient.capabilities());

      assert.equal(recovered.runtime, "browser");
      assert.equal(retryCoreRequests, 2);
      assert.equal(workerCreations, 3);
      await expectWorkers(1);

      console.log("Failed core download terminates its worker; same-client retry succeeds.");

      await page.evaluate(() => globalThis.__mavioLifecycleClient.dispose());

      await expectWorkers(0);

      await checkInterruptedInitialization("timeout");
      await checkInterruptedInitialization("cancel");
      await checkInterruptedInitialization("dispose");

      const creationsBeforeMetadata = workerCreations;

      const metadataResult = await page.evaluate(async (baseURL) => {
        const { runBrowserMetadataSmoke } = await import("/metadata-smoke.mjs");

        return runBrowserMetadataSmoke(baseURL);
      }, origin);

      await expectWorkers(0);

      assert.equal(workerCreations, creationsBeforeMetadata + 2);
      assert.equal(metadataResult.invalidCode, "INVALID_MEDIA");

      console.table(metadataResult);
      console.log("Public browser WAV metadata passed for bytes, Blob and File.");
      console.log("Browser metadata preserves caller input content.");
      console.log("Invalid browser media rejects; same-client recovery passes.");
      console.log("Browser metadata responses are independent snapshots.");
      console.log("Metadata client disposal leaves no active worker.");

      if (process.env.MAVIO_BROWSER_SMOKE === "cancellation") {
        const creationsBeforeCancellation = workerCreations;

        const result = await page.evaluate(async (baseURL) => {
          const { runBrowserCancellationSmoke } = await import("/cancellation-smoke.mjs");

          return runBrowserCancellationSmoke(baseURL);
        }, origin);

        await expectWorkers(0);

        assert.equal(result.pcmSamplesExact, true);
        assert.equal(workerCreations, creationsBeforeCancellation + 2);
        assert.equal(result.targetedExecutions, 1);
        assert.equal(result.progressObserved, true);
        assert.ok(result.cancellationMilliseconds < 10000);
        assert.equal(result.decodedRecoverySamples, 6000);

        assert.deepEqual(missing, []);
        assert.deepEqual(pageErrors, []);

        console.table(result);
        console.log("Public browser cancellation interrupts encoding after real progress.");
        console.log("Cancelled encoding rejects without publishing output.");
        console.log("The same client reloads its worker and completes recovery.");
        console.log("Recovery PCM decodes after disposal and exactly preserves source samples.");
        console.log("The complete suite checks the stack regression separately.");

        return;
      }

      if (process.env.MAVIO_BROWSER_SMOKE === "thumbnail-public") {
        const creationsBeforePublicThumbnail = workerCreations;

        const results = await page.evaluate(async (baseURL) => {
          const { runBrowserThumbnailSmoke } = await import("/thumbnail-smoke.mjs");

          return runBrowserThumbnailSmoke(baseURL, {
            advanced: true,
            publicExport: true,
          });
        }, origin);

        await expectWorkers(0);

        // Per preset: fixture worker, public worker, recovery worker.
        assert.equal(workerCreations, creationsBeforePublicThumbnail + 6);

        assert.equal(results.length, 10);

        for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
          const rows = results.filter((row) => row.preset === preset);

          assert.deepEqual(
            rows.map((row) => `${row.case}/${row.inputKind}/${row.outputKind}`).sort(),
            [
              "after-empty/bytes/bytes",
              "matrix/blob/blob",
              "matrix/blob/bytes",
              "matrix/bytes/blob",
              "matrix/bytes/bytes",
            ],
          );

          for (const row of rows) {
            assert.equal(row.width, 158);
            assert.equal(row.height, preset === "jpeg-balanced-v1" ? 88 : 89);
            assert.equal(row.referenceMatched, true);
            assert.ok(row.outputBytes > 0);
          }
        }

        assert.deepEqual(missing, []);
        assert.deepEqual(pageErrors, []);

        console.table(results);
        console.log("All eight public thumbnail input/output combinations passed.");
        console.log("Empty public thumbnail selection rejects; same-client recovery passes.");
        console.log(
          "All ten public thumbnails decode and match independent references after disposal.",
        );
        console.log(
          "Public thumbnail trim, sequential resize and caller-content preservation passed.",
        );
        console.log("The complete suite checks MP4 trim and the stack regression separately.");

        return;
      }

      if (process.env.MAVIO_BROWSER_SMOKE === "thumbnail-selection") {
        const creationsBeforeThumbnailSelection = workerCreations;

        const results = await page.evaluate(async (baseURL) => {
          const { runBrowserThumbnailSmoke } = await import("/thumbnail-smoke.mjs");

          return runBrowserThumbnailSmoke(baseURL, { advanced: true });
        }, origin);

        await expectWorkers(0);

        assert.equal(workerCreations, creationsBeforeThumbnailSelection + 2);

        assert.equal(results.length, 4);

        for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
          const rows = results.filter((row) => row.preset === preset);

          assert.deepEqual(rows.map((row) => row.inputKind).sort(), ["blob", "bytes"]);

          for (const row of rows) {
            assert.equal(row.width, 158);
            assert.equal(row.height, preset === "jpeg-balanced-v1" ? 88 : 89);
            assert.equal(row.referenceMatched, true);
            assert.ok(row.outputBytes > 0);
          }
        }

        assert.deepEqual(missing, []);
        assert.deepEqual(pageErrors, []);

        console.table(results);
        console.log("Browser thumbnails match independently selected source frame 2.");
        console.log("Trim-relative thumbnail selection preserves the intended source frame.");
        console.log("Sequential thumbnail resize preserves dimensions without upscaling.");
        console.log("Resized JPEG and PNG pixels match their independent references.");
        console.log("Thumbnail outputs decode and compare after worker termination.");
        console.log(
          "The complete suite checks public thumbnails and the stack regression separately.",
        );

        return;
      }

      if (process.env.MAVIO_BROWSER_SMOKE === "thumbnail") {
        const creationsBeforeThumbnail = workerCreations;

        const results = await page.evaluate(async (baseURL) => {
          const { runBrowserThumbnailSmoke } = await import("/thumbnail-smoke.mjs");

          return runBrowserThumbnailSmoke(baseURL);
        }, origin);

        await expectWorkers(0);

        assert.equal(workerCreations, creationsBeforeThumbnail + 2);
        assert.equal(results.length, 4);

        for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
          const rows = results.filter((row) => row.preset === preset);

          assert.deepEqual(rows.map((row) => row.inputKind).sort(), ["blob", "bytes"]);

          for (const row of rows) {
            assert.ok(row.outputBytes > 0);
            assert.equal(row.width, 160);
            assert.equal(row.height, 90);
          }
        }

        assert.deepEqual(missing, []);
        assert.deepEqual(pageErrors, []);

        console.table(results);
        console.log("Browser JPEG and PNG preparation passed for byte and Blob inputs.");
        console.log("All four thumbnails decode in Chromium after worker termination.");
        console.log("Browser thumbnail preparation preserves caller content and cleans staging.");
        console.log("The complete suite checks public thumbnails and frame selection separately.");

        return;
      }

      if (process.env.MAVIO_BROWSER_SMOKE === "audio-trim-public") {
        const creationsBeforePublicTrim = workerCreations;

        const results = await page.evaluate(async (baseURL) => {
          const { runPublicBrowserAudioTrimSmoke } = await import("/audio-smoke.mjs");

          return runPublicBrowserAudioTrimSmoke(baseURL);
        }, origin);

        await expectWorkers(0);

        // Two clients, each reloaded once after empty-trim rejection,
        // followed by one independent verification worker.
        assert.equal(workerCreations, creationsBeforePublicTrim + 5);
        assert.equal(results.length, 10);

        for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
          const rows = results.filter((row) => row.preset === preset);

          assert.deepEqual(
            rows.map((row) => `${row.case}/${row.inputKind}/${row.outputKind}`).sort(),
            [
              "after-empty/bytes/bytes",
              "consecutive/blob/blob",
              "consecutive/blob/bytes",
              "fractional/bytes/blob",
              "fractional/bytes/bytes",
            ],
          );

          for (const row of rows) {
            assert.ok(row.outputBytes > 0);
            assert.ok(row.decodedSamples > 0);

            if (preset === "audio-pcm-v1") {
              assert.equal(row.decodedSamples, 6000);
            }
          }
        }

        assert.deepEqual(missing, []);
        assert.deepEqual(pageErrors, []);

        console.table(results);
        console.log("Public browser fractional and consecutive audio trims passed.");
        console.log("Public audio trim supports byte and Blob input/output.");
        console.log("Empty public audio trim rejects; same-client recovery decodes.");
        console.log("Public trimmed PCM exactly matches the requested 6000 source samples.");
        console.log("All ten public trimmed outputs decode after client disposal.");
        console.log("The complete suite checks MP4 trim and the stack regression separately.");

        return;
      }

      if (process.env.MAVIO_BROWSER_SMOKE === "audio-trim-preparation") {
        const creationsBeforeTrimPreparation = workerCreations;

        const results = await page.evaluate(async (baseURL) => {
          const { runBrowserAudioTrimPreparationSmoke } = await import("/audio-smoke.mjs");

          return runBrowserAudioTrimPreparationSmoke(baseURL);
        }, origin);

        await expectWorkers(0);

        assert.equal(workerCreations, creationsBeforeTrimPreparation + 3);
        assert.equal(results.length, 4);

        for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
          const rows = results.filter((row) => row.preset === preset);

          assert.deepEqual(rows.map((row) => row.case).sort(), [
            "consecutive-blob",
            "fractional-bytes",
          ]);

          for (const row of rows) {
            assert.equal(row.selectedSamples, 6000);
            assert.ok(row.outputBytes > 0);
            assert.ok(row.decodedSamples > 0);

            if (preset === "audio-pcm-v1") {
              assert.equal(row.decodedSamples, 6000);
            }
          }
        }

        assert.deepEqual(missing, []);
        assert.deepEqual(pageErrors, []);

        console.table(results);
        console.log("Both browser audio presets prepare fractional and consecutive trims.");
        console.log("All four trimmed outputs decode after preparation worker termination.");
        console.log("Trimmed PCM WAV exactly matches the requested 6000 source samples.");
        console.log("Browser audio trim preparation preserves caller content and cleans staging.");
        console.log(
          "The complete suite checks public audio trim and the stack regression separately.",
        );

        return;
      }

      if (process.env.MAVIO_BROWSER_SMOKE === "audio-trim-analysis") {
        const creationsBeforeAudioTrim = workerCreations;

        const result = await page.evaluate(async (baseURL) => {
          const { runBrowserAudioTrimAnalysisSmoke } = await import("/audio-smoke.mjs");

          return runBrowserAudioTrimAnalysisSmoke(baseURL);
        }, origin);

        await expectWorkers(0);

        assert.equal(workerCreations, creationsBeforeAudioTrim + 1);
        assert.equal(result.fractionalSamples, 6000);
        assert.equal(result.consecutiveSamples, 6000);
        assert.equal(result.recoveredSamples, 6000);
        assert.equal(result.emptyCode, "INVALID_OPTIONS");

        assert.deepEqual(missing, []);
        assert.deepEqual(pageErrors, []);

        console.table(result);
        console.log("Browser fractional audio trim selects 6000 samples per channel.");
        console.log("Browser consecutive audio trims select the expected source interval.");
        console.log("Browser empty-audio trim rejects; same-worker analysis recovers.");
        console.log("Browser audio trim analysis preserves source content and cleans staging.");
        console.log(
          "The complete suite checks public audio trim and the stack regression separately.",
        );

        return;
      }

      if (process.env.MAVIO_BROWSER_SMOKE === "preset-quality-public") {
        const creationsBeforeQuality = workerCreations;

        const results = await page.evaluate(async (baseURL) => {
          const { runBrowserResizeSmoke } = await import("/resize-smoke.mjs");
          const rows = [];
          for (const [sourceWidth, sourceHeight] of [
            [320, 180],
            [180, 320],
          ]) {
            rows.push(
              ...(await runBrowserResizeSmoke(baseURL, {
                publicAPI: true,
                compression: true,
                measureQuality: true,
                sourceWidth,
                sourceHeight,
              })),
            );
          }
          return rows;
        }, origin);

        await expectWorkers(0);
        assert.equal(workerCreations, creationsBeforeQuality + 8);
        assert.equal(results.length, 16);

        for (const fixture of ["landscape-motion", "portrait-motion"]) {
          for (const preset of ["video-balanced-v1", "video-small-v1"]) {
            const rows = results.filter((row) => row.fixture === fixture && row.preset === preset);
            assert.deepEqual(rows.map((row) => row.inputKind + "-" + row.outputKind).sort(), [
              "blob-blob",
              "blob-bytes",
              "bytes-blob",
              "bytes-bytes",
            ]);

            for (const row of rows) {
              assert.equal(row.route, "public");
              assert.equal(row.operation, "compress");
              assert.equal(row.audio, false);
              assert.equal(row.videoFrames, 12);
              assert.equal(row.width, fixture === "landscape-motion" ? 320 : 180);
              assert.equal(row.height, fixture === "landscape-motion" ? 180 : 320);
              assert.equal(row.minimumLumaPSNRdB, preset === "video-balanced-v1" ? 38 : 34);
              assert.ok(row.lumaPSNRdB === "identical" || row.lumaPSNRdB >= row.minimumLumaPSNRdB);
              assert.ok(Number.isFinite(row.lumaMSE) && row.lumaMSE >= 0);
              assert.ok(row.lumaPSNRdB === "identical" || Number.isFinite(row.lumaPSNRdB));
            }
          }
        }

        assert.deepEqual(missing, []);
        assert.deepEqual(pageErrors, []);
        console.table(
          results.map((row) => ({
            fixture: row.fixture,
            preset: row.preset,
            inputKind: row.inputKind,
            outputKind: row.outputKind,
            frames: row.videoFrames,
            outputBytes: row.outputBytes,
            lumaMSE: row.lumaMSE,
            lumaPSNRdB: row.lumaPSNRdB,
            minimumLumaPSNRdB: row.minimumLumaPSNRdB,
          })),
        );
        console.log("All 16 public Browser preset quality gates passed after disposal.");
        console.log("Metrics measure additional luma encoding error against the decoded source.");
        return;
      }

      if (process.env.MAVIO_BROWSER_SMOKE === "compression-public") {
        const creationsBeforeCompression = workerCreations;

        const results = await page.evaluate(async (baseURL) => {
          const { runBrowserResizeSmoke } = await import("/resize-smoke.mjs");
          return runBrowserResizeSmoke(baseURL, { publicAPI: true, compression: true });
        }, origin);

        await expectWorkers(0);
        assert.equal(workerCreations, creationsBeforeCompression + 8);
        assert.equal(results.length, 16);

        for (const audio of [false, true]) {
          for (const inputKind of ["bytes", "blob"]) {
            for (const outputKind of ["bytes", "blob"]) {
              const rows = results.filter(
                (row) =>
                  row.audio === audio &&
                  row.inputKind === inputKind &&
                  row.outputKind === outputKind,
              );

              assert.deepEqual(rows.map((row) => row.preset).sort(), [
                "video-balanced-v1",
                "video-small-v1",
              ]);

              const balanced = rows.find((row) => row.preset === "video-balanced-v1");
              const small = rows.find((row) => row.preset === "video-small-v1");
              assert.equal(balanced.sourceBytes, small.sourceBytes);
              assert.ok(
                small.outputBytes < balanced.outputBytes,
                "Small preset must be smaller on this controlled fixture.",
              );

              for (const row of rows) {
                assert.equal(row.case, "compress");
                assert.equal(row.operation, "compress");
                assert.equal(row.route, "public");
                assert.equal(row.width, 320);
                assert.equal(row.height, 180);
                assert.equal(row.videoFrames, 6);
                assert.ok(
                  row.outputBytes > 0 && row.outputBytes < row.sourceBytes,
                  "Expected size reduction on the controlled source fixture.",
                );
                if (audio) assert.ok(row.decodedAudioSamples > 0);
                else assert.equal(row.decodedAudioSamples, 0);
              }
            }
          }
        }

        assert.deepEqual(missing, []);
        assert.deepEqual(pageErrors, []);
        console.table(results);
        console.log("All 16 public MP4 compression combinations passed.");
        console.log(
          "Dimensions, frames, timestamps, audio, source preservation and post-disposal decoding passed.",
        );
        console.log("Both presets reduced this fixture; small was smaller than balanced.");
        console.log(
          "Fixture-specific size checks do not guarantee smaller output for arbitrary media.",
        );
        return;
      }

      if (process.env.MAVIO_BROWSER_SMOKE === "audio-selection-public") {
        const creationsBeforeSelection = workerCreations;
        const results = await page.evaluate(async (baseURL) => {
          const { runPublicBrowserAudioSelectionSmoke } = await import("/audio-smoke.mjs");
          return runPublicBrowserAudioSelectionSmoke(baseURL);
        }, origin);

        await expectWorkers(0);
        assert.ok(workerCreations > creationsBeforeSelection);
        assert.equal(results.length, 24);

        for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
          const rows = results.filter((row) => row.preset === preset);
          assert.equal(rows.length, 12);

          for (const inputKind of ["bytes", "blob"]) {
            for (const outputKind of ["bytes", "blob"]) {
              assert.deepEqual(
                rows
                  .filter(
                    (row) =>
                      row.inputKind === inputKind &&
                      row.outputKind === outputKind &&
                      ["default", "explicit-second"].includes(row.operation),
                  )
                  .map((row) => row.operation)
                  .sort(),
                ["default", "explicit-second"],
              );
            }
          }

          assert.deepEqual(
            rows
              .filter((row) => row.operation.startsWith("recover-"))
              .map((row) => row.operation)
              .sort(),
            [
              "recover-absent-index",
              "recover-missing-audio-default",
              "recover-missing-audio-extraction",
              "recover-video-index",
            ],
          );

          for (const row of rows) {
            assert.equal(row.selectedIndex, row.operation === "explicit-second" ? 2 : 1);
            assert.equal(row.sampleRate, row.selectedIndex === 2 ? 44100 : 48000);
            assert.equal(row.channels, 1);
            assert.ok(row.decodedSamples > 0);
            assert.ok(row.outputBytes > 0);
          }
        }

        assert.deepEqual(missing, []);
        assert.deepEqual(pageErrors, []);
        console.table(results);
        console.log("Public multi-track selection preserves 48000/44100 Hz mono profiles.");
        console.log("Video/absent indexes and missing audio reject; same-client recovery passed.");
        console.log("All 24 outputs decode after disposal; PCM matches the selected source track.");
        return;
      }

      if (process.env.MAVIO_BROWSER_SMOKE === "audio-public") {
        const creationsBeforePublicAudio = workerCreations;

        const results = await page.evaluate(async (baseURL) => {
          const { runPublicBrowserAudioSmoke } = await import("/audio-smoke.mjs");

          return runPublicBrowserAudioSmoke(baseURL);
        }, origin);

        await expectWorkers(0);

        // Each client loads initially and reloads after two rejected jobs.
        // Six client workers plus one independent decoding worker.
        assert.equal(workerCreations, creationsBeforePublicAudio + 7);
        assert.equal(results.length, 24);

        for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
          for (const inputKind of ["bytes", "blob"]) {
            for (const outputKind of ["bytes", "blob"]) {
              const rows = results.filter(
                (row) =>
                  row.preset === preset &&
                  row.inputKind === inputKind &&
                  row.outputKind === outputKind &&
                  ["convert", "compress"].includes(row.operation),
              );

              assert.deepEqual(rows.map((row) => row.operation).sort(), ["compress", "convert"]);

              for (const row of rows) {
                assert.ok(row.outputBytes > 0);
                assert.ok(row.decodedSamples > 0);

                if (preset === "audio-pcm-v1") {
                  assert.equal(row.decodedSamples, 12000);
                }
              }
            }
          }
        }

        for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
          const rows = results.filter(
            (row) => row.preset === preset && !["convert", "compress"].includes(row.operation),
          );

          assert.deepEqual(rows.map((row) => row.operation).sort(), [
            "extract-default",
            "extract-explicit",
            "recover-invalid-media",
            "recover-invalid-stream",
          ]);

          for (const row of rows) {
            assert.ok(row.outputBytes > 0);
            assert.ok(row.decodedSamples > 0);

            if (preset === "audio-pcm-v1") {
              assert.equal(row.decodedSamples, 12000);
            }
          }
        }

        assert.deepEqual(missing, []);
        assert.deepEqual(pageErrors, []);

        console.table(results);
        console.log("All sixteen public browser audio export combinations passed.");
        console.log("Public audio byte and Blob outputs decode after client disposal.");
        console.log("Public PCM exports exactly preserve the source samples.");
        console.log("Public audio exports preserve caller bytes and Blob content.");
        console.log(
          "Focused public audio check passed; the complete suite checks the stack regression separately.",
        );

        console.log("Public browser default and explicit audio selection passed.");
        console.log("Invalid audio stream selection rejects; same-client recovery decodes.");
        console.log("Invalid browser audio media rejects; same-client recovery decodes.");
        console.log("All twenty-four public audio outputs decode after client disposal.");

        return;
      }

      if (process.env.MAVIO_BROWSER_SMOKE === "audio") {
        const creationsBeforeAudio = workerCreations;

        const audioResults = await page.evaluate(async (baseURL) => {
          const { runBrowserAudioSmoke } = await import("/audio-smoke.mjs");

          return runBrowserAudioSmoke(baseURL);
        }, origin);

        await expectWorkers(0);

        assert.equal(workerCreations, creationsBeforeAudio + 3);
        assert.equal(audioResults.length, 4);

        for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
          const rows = audioResults.filter((row) => row.preset === preset);

          assert.deepEqual(rows.map((row) => row.inputKind).sort(), ["blob", "bytes"]);

          for (const row of rows) {
            assert.ok(row.outputBytes > 0);
            assert.ok(row.decodedSamples > 0);

            if (preset === "audio-pcm-v1") {
              assert.equal(row.decodedSamples, 12000);
            }
          }
        }

        assert.deepEqual(missing, []);
        assert.deepEqual(pageErrors, []);

        console.table(audioResults);
        console.log("Both browser audio presets prepare bytes and Blob inputs.");
        console.log("All four audio outputs decode after preparation worker termination.");
        console.log("PCM WAV output exactly preserves the source samples.");
        console.log("Browser audio staging cleanup and caller input preservation passed.");
        console.log(
          "Focused audio check passed; the complete suite checks public audio and the stack regression separately.",
        );

        return;
      }

      if (["resize", "resize-public"].includes(process.env.MAVIO_BROWSER_SMOKE)) {
        const publicResize = process.env.MAVIO_BROWSER_SMOKE === "resize-public";
        const creationsBeforeResize = workerCreations;

        const resizeResults = await page.evaluate(
          async ({ baseURL, publicAPI }) => {
            const { runBrowserResizeSmoke } = await import("/resize-smoke.mjs");

            return runBrowserResizeSmoke(baseURL, { publicAPI });
          },
          { baseURL: origin, publicAPI: publicResize },
        );

        await expectWorkers(0);

        assert.equal(workerCreations, creationsBeforeResize + (publicResize ? 8 : 4));

        assert.equal(resizeResults.length, publicResize ? 48 : 12);

        for (const preset of ["video-balanced-v1", "video-small-v1"]) {
          for (const audio of [false, true]) {
            const rows = resizeResults.filter(
              (row) => row.preset === preset && row.audio === audio,
            );

            const expectedCases = ["consecutive-resize", "resize", "trim-resize"];

            assert.deepEqual(
              rows.map((row) => row.case).sort(),
              expectedCases.flatMap((name) => Array(publicResize ? 4 : 1).fill(name)).sort(),
            );

            if (publicResize) {
              for (const name of expectedCases) {
                assert.deepEqual(
                  rows
                    .filter((row) => row.case === name)
                    .map((row) => row.inputKind + "-" + row.outputKind)
                    .sort(),
                  ["blob-blob", "blob-bytes", "bytes-blob", "bytes-bytes"],
                );
              }

              assert.ok(rows.every((row) => row.route === "public"));
            }
          }
        }

        for (const row of resizeResults) {
          assert.equal(row.width, row.case === "consecutive-resize" ? 158 : 160);

          assert.equal(row.height, row.case === "consecutive-resize" ? 88 : 90);

          assert.equal(row.videoFrames, row.case === "trim-resize" ? 3 : 6);

          assert.ok(row.outputBytes > 0);

          if (row.audio) {
            assert.ok(row.decodedAudioSamples > 0);
          } else {
            assert.equal(row.decodedAudioSamples, 0);
          }
        }

        assert.deepEqual(missing, []);
        assert.deepEqual(pageErrors, []);

        console.table(resizeResults);

        console.log(
          publicResize
            ? "All 48 public browser MP4 resize combinations passed."
            : "Both browser MP4 presets passed focused resize preparation.",
        );

        if (publicResize) {
          console.log("Public resize outputs decode after client disposal.");
        }
        console.log("Consecutive browser resize preserves 158x88 without upscaling.");
        console.log("Browser resize frame counts, timestamps and square pixels passed.");
        console.log("Browser resized video and audio decoding passed.");
        console.log("Browser resize staging cleanup and byte ownership passed.");
        console.log(
          "Focused resize check passed; the complete suite checks the stack regression separately.",
        );

        return;
      }

      const creationsBeforeMp4 = workerCreations;

      const mp4Results = await page.evaluate(async (baseURL) => {
        const { runBrowserMp4Smoke } = await import("/mp4-smoke.mjs");
        return runBrowserMp4Smoke(baseURL);
      }, origin);

      await expectWorkers(0);

      assert.equal(workerCreations, creationsBeforeMp4 + 7);
      assert.equal(mp4Results.length, 4);

      for (const row of mp4Results) {
        assert.equal(row.trimVideoFrames, 3);
        assert.equal(row.trimAudioSamples, row.audio ? 12_000 : 0);
        assert.equal(row.consecutiveTrimVideoFrames, 2);
        assert.equal(row.consecutiveTrimAudioSamples, row.audio ? 6_000 : 0);
        assert.equal(row.emptyTrimRejected, true);
        assert.equal(row.trimmedPreparations, 2);
        assert.equal(row.publicTrims, 4);
        assert.equal(row.publicEmptyTrimRejected, true);
      }

      assert.ok(
        mp4Results.every((row) => row.preparedInputs === 2),
        "Expected bytes and Blob preparation for every preset/audio case.",
      );

      assert.equal(
        mp4Results.reduce((total, row) => total + row.preparedInputs, 0),
        8,
      );

      assert.ok(
        mp4Results.every((row) => row.publicExports === 4),
        "Expected all public byte/Blob input/output combinations.",
      );

      console.table(mp4Results);
      console.log("Both browser MP4 presets encode and validate with and without audio.");
      console.log("Browser MP4 outputs decode to six video frames.");
      console.log("Browser MP4 audio outputs decode successfully.");
      console.log("Browser intermediate overwrite protection passed.");
      console.log("Browser MP4 source files remain unchanged.");
      console.log("Browser MP4 bytes survive workspace cleanup and worker termination.");

      console.log("Integrated browser MP4 preparation passed for bytes and Blob inputs.");
      console.log("All eight prepared outputs decode after preparation workspace cleanup.");
      console.log("Prepared browser MP4 inputs remain unchanged.");
      console.log("Prepared browser MP4 bytes survive worker termination.");

      console.log("All sixteen public browser MP4 export combinations passed.");
      console.log("Public browser export rejects invalid media and recovers.");
      console.log("All thirty-three public MP4 outputs decode after client disposal.");
      console.log(
        "Sixteen public fractional/consecutive MP4 trims passed; empty trims reject and recover.",
      );
      console.log("Public browser MP4 exports preserve caller input content.");

      console.log("Browser fractional trim analysis selects three video frames.");
      console.log("Browser fractional audio trim selects 12000 samples per channel.");
      console.log("Browser empty-video trim selection rejects before encoding.");
      console.log("Browser consecutive trim analysis selects two frames and 6000 audio samples.");
      console.log("Browser trim analysis recovers and preserves its source.");

      console.log("All eight browser trimmed preparations encode, validate and decode.");
      console.log("Browser fractional trim preserves three frames and the requested time origin.");
      console.log("Browser consecutive trim preserves two frames and source-relative timestamps.");
      console.log("Browser trimmed bytes survive staging cleanup and worker termination.");

      assert.deepEqual(missing, []);
      assert.deepEqual(pageErrors, []);

      console.log("All public browser lifecycle checks passed.");
      console.log("Public MP4 trim and the corrected long-sequence smoke passed.");
    }

    await Promise.race([
      checks(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Public browser lifecycle check timed out.")),
          240_000,
        );
      }),
    ]);
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
  console.error("Public browser lifecycle check failed.");
  console.error(error);
  process.exitCode = 1;
}
