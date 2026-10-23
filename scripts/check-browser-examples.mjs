import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { startExampleServer, stopExampleServer } from "./example-server.mjs";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
}

async function main() {
  assert.equal(
    process.argv.length,
    6,
    "Provide prepared examples directory, FFmpeg, FFprobe, and fixture paths.",
  );

  const [examplesDirectory, ffmpegPath, ffprobePath, fixturePath] = process.argv
    .slice(2)
    .map((value) => resolve(value));

  for (const path of [examplesDirectory, ffmpegPath, ffprobePath, fixturePath]) {
    assert.ok(existsSync(path), "Missing path: " + path);
  }

  const input = JSON.parse(
    run(ffprobePath, ["-v", "error", "-show_streams", "-of", "json", fixturePath]),
  );
  const inputVideo = input.streams.find((stream) => stream.codec_type === "video");
  assert.ok(inputVideo?.width > 0 && inputVideo?.height > 0);
  const scale = Math.min(1, 640 / inputVideo.width, 360 / inputVideo.height);
  const expectedWidth = Math.floor((inputVideo.width * scale) / 2) * 2;
  const expectedHeight = Math.floor((inputVideo.height * scale) / 2) * 2;

  const outputs = mkdtempSync(join(tmpdir(), "mavio-browser-example-outputs-"));
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.MAVIO_BROWSER_CHANNEL ? { channel: process.env.MAVIO_BROWSER_CHANNEL } : {}),
  });

  console.info("Browser examples: Chromium " + browser.version());

  try {
    for (const name of ["vanilla-js", "vanilla-ts"]) {
      const server = await startExampleServer(examplesDirectory, name);
      let page;

      try {
        page = await browser.newPage();
        page.setDefaultTimeout(120_000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));

        await page.addInitScript(() => {
          const OriginalWorker = globalThis.Worker;
          const state = { created: 0, active: 0 };
          globalThis.__mavioExampleWorkers = state;

          globalThis.Worker = class extends OriginalWorker {
            constructor(url, options) {
              super(url, options);
              this.mavioTracked = true;
              state.created++;
              state.active++;
            }

            terminate() {
              if (this.mavioTracked) {
                this.mavioTracked = false;
                state.active--;
              }
              return super.terminate();
            }
          };
        });

        await page.goto(server.origin);
        assert.equal(await page.evaluate(() => globalThis.__mavioExampleWorkers.active), 0);

        await page.locator("#media").setInputFiles({
          name: "invalid.mp4",
          mimeType: "video/mp4",
          buffer: Buffer.from("not valid media"),
        });
        await page.locator("#run").click();
        await page.waitForFunction(
          () =>
            !globalThis.document.getElementById("run").disabled &&
            /^(INVALID_MEDIA|UNSUPPORTED_CAPABILITY):/.test(
              globalThis.document.getElementById("status").textContent,
            ),
        );
        assert.equal(await page.locator("#download").isVisible(), false);
        assert.equal(await page.evaluate(() => globalThis.__mavioExampleWorkers.active), 0);

        await page.locator("#media").setInputFiles(fixturePath);

        // Exercise deterministic immediate UI cancellation, not active-encode timing.
        await page.evaluate(() => {
          globalThis.document.getElementById("run").click();
          globalThis.document.getElementById("cancel").click();
        });
        await page.waitForFunction(
          () =>
            !globalThis.document.getElementById("run").disabled &&
            globalThis.document.getElementById("status").textContent.startsWith("CANCELLED:"),
        );
        assert.equal(await page.locator("#download").isVisible(), false);
        assert.equal(await page.evaluate(() => globalThis.__mavioExampleWorkers.active), 0);

        await page.locator("#run").click();
        await page.locator("#download").waitFor({ state: "visible" });
        assert.match(await page.locator("#status").textContent(), /^Completed\./);
        assert.equal(await page.locator("#run").isEnabled(), true);
        assert.equal(await page.locator("#cancel").isDisabled(), true);

        const workers = await page.evaluate(() => globalThis.__mavioExampleWorkers);
        assert.ok(workers.created >= 2);
        assert.equal(workers.active, 0);

        const pendingDownload = page.waitForEvent("download");
        await page.locator("#download").click();
        const download = await pendingDownload;
        const output = join(outputs, name + ".mp4");
        await download.saveAs(output);
        assert.equal(await download.failure(), null);

        const metadata = JSON.parse(
          run(ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", output]),
        );
        const video = metadata.streams.find((stream) => stream.codec_type === "video");
        assert.equal(video?.codec_name, "h264");
        assert.equal(video.width, expectedWidth);
        assert.equal(video.height, expectedHeight);
        assert.ok(Number(metadata.format.duration) > 0);

        if (input.streams.some((stream) => stream.codec_type === "audio")) {
          assert.ok(
            metadata.streams.some(
              (stream) => stream.codec_type === "audio" && stream.codec_name === "aac",
            ),
          );
        }

        run(ffmpegPath, [
          "-hide_banner",
          "-v",
          "error",
          "-xerror",
          "-i",
          output,
          "-f",
          "null",
          "-",
        ]);

        assert.deepEqual(errors, []);
        console.info(
          "PASS: " +
            name +
            ": invalid input, immediate cancellation, recovery, download, " +
            "worker cleanup, geometry, and independent decoding.",
        );
      } finally {
        try {
          if (page) await page.close();
        } finally {
          await stopExampleServer(server);
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.info("PASS: both installed-package Browser examples.");
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
