import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { startExampleServer, stopExampleServer } from "./example-server.mjs";

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
}

async function main() {
  assert.equal(
    process.argv.length,
    6,
    "Provide prepared Browser consumer directory, FFmpeg, FFprobe, and fixture.",
  );
  const [consumer, ffmpegPath, ffprobePath, fixturePath] = process.argv
    .slice(2)
    .map((value) => resolve(value));

  for (const path of [consumer, ffmpegPath, ffprobePath, fixturePath]) {
    assert.ok(existsSync(path), "Missing path: " + path);
  }
  const name = basename(consumer);
  assert.ok(["vanilla-js", "vanilla-ts"].includes(name));

  const consumerRequire = createRequire(join(consumer, "package.json"));
  const sdkEntry = consumerRequire.resolve("@vormir/mavio/browser");
  assert.equal(
    realpathSync(sdkEntry),
    realpathSync(join(consumer, "node_modules/@vormir/mavio/dist/browser.js")),
  );

  const manifest = JSON.parse(
    readFileSync(join(consumer, "public/mavio-engine/manifest.json"), "utf8"),
  );
  assert.equal(manifest.correction, "restore-stack-after-native-entry-v1");

  const sdk = JSON.parse(
    readFileSync(join(consumer, "node_modules/@vormir/mavio/package.json"), "utf8"),
  );
  const lockPath = join(consumer, "package-lock.json");
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : undefined;
  const fixture = readFileSync(fixturePath);
  const input = JSON.parse(
    run(ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", fixturePath]),
  );
  const inputVideo = input.streams.find((stream) => stream.codec_type === "video");
  assert.ok(inputVideo);

  const id = "m6-benchmark-" + randomUUID();
  const bundle = await build({
    stdin: {
      contents: readFileSync(
        fileURLToPath(new URL("./browser-benchmark-entry.mjs", import.meta.url)),
        "utf8",
      ),
      resolveDir: consumer,
      sourcefile: "browser-benchmark-entry.mjs",
      loader: "js",
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["browser"],
    write: false,
  });
  assert.equal(bundle.outputFiles.length, 1);

  writeFileSync(join(consumer, "public", id + ".js"), bundle.outputFiles[0].contents, {
    flag: "wx",
  });
  writeFileSync(join(consumer, "public", id + ".mp4"), fixture, { flag: "wx" });

  const outputDirectory = mkdtempSync(join(tmpdir(), "mavio-browser-benchmark-"));
  const server = await startExampleServer(dirname(consumer), name);
  let browser;
  let timer;

  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.MAVIO_BROWSER_CHANNEL ? { channel: process.env.MAVIO_BROWSER_CHANNEL } : {}),
    });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.addInitScript(() => {
      const OriginalWorker = globalThis.Worker;
      const state = { created: 0, active: 0 };
      globalThis.__mavioBenchmarkWorkers = state;
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
    const measured = await Promise.race([
      page.evaluate(async (id) => {
        const { runBrowserBenchmark } = await import("/" + id + ".js");
        return runBrowserBenchmark("/" + id + ".mp4");
      }, id),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Browser benchmark exceeded four minutes.")),
          240_000,
        );
      }),
    ]);
    clearTimeout(timer);

    const workers = await page.evaluate(() => globalThis.__mavioBenchmarkWorkers);
    assert.equal(workers.created, 4);
    assert.equal(workers.active, 0);
    assert.deepEqual(pageErrors, []);
    assert.equal(measured.sourceUnchanged, true);

    const fixtureSha256 = createHash("sha256").update(fixture).digest("hex");
    assert.equal(measured.fixtureSha256, fixtureSha256);
    assert.equal(measured.outputs.length, 3);

    for (const [index, bytes] of measured.outputs.entries()) {
      const output = join(outputDirectory, "export-" + index + ".mp4");
      writeFileSync(output, Buffer.from(bytes));
      const metadata = JSON.parse(
        run(ffprobePath, ["-v", "error", "-show_streams", "-of", "json", output]),
      );
      const video = metadata.streams.find((stream) => stream.codec_type === "video");
      assert.equal(video?.codec_name, "h264");
      assert.equal(video.width, inputVideo.width);
      assert.equal(video.height, inputVideo.height);
      if (input.streams.some((stream) => stream.codec_type === "audio")) {
        assert.ok(metadata.streams.some((stream) => stream.codec_type === "audio"));
      }
      run(ffmpegPath, ["-hide_banner", "-v", "error", "-xerror", "-i", output, "-f", "null", "-"]);
    }

    const report = {
      recordedAt: new Date().toISOString(),
      environment: {
        driverNode: process.version,
        platform: platform(),
        architecture: arch(),
        osRelease: release(),
        cpu: cpus()[0]?.model,
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        chromium: browser.version(),
        sdkVersion: sdk.version,
        sdkArchiveIntegrity: lock?.packages?.["node_modules/@vormir/mavio"]?.integrity,
        coreVersion: manifest.coreVersion,
        wrapperVersion: manifest.wrapperVersion,
        ...measured.browserEnvironment,
      },
      fixture: {
        sha256: fixtureSha256,
        sizeBytes: fixture.byteLength,
        durationSeconds: Number(input.format.duration),
        width: inputVideo.width,
        height: inputVideo.height,
        frameRate: inputVideo.avg_frame_rate,
      },
      phases: measured.phases,
      verification: {
        decodedExportsAfterDisposal: measured.outputs.length,
        sourceUnchanged: measured.sourceUnchanged,
        workersCreated: workers.created,
        activeWorkersAfterDisposal: workers.active,
      },
      limitations: [
        "Local observations; no speed threshold or performance guarantee.",
        "Fresh client does not guarantee cold browser, OS, or compiled-WASM caches.",
        "Engine assets are served locally; deployment network latency differs.",
        "Timing excludes setup bundling, fixture fetch, result transfer, and decoding.",
        "Progress and diagnostic observers are disabled.",
        "This benchmark does not measure main-page, worker, WASM, or total process memory.",
        "Native path input and Browser byte input have different preparation costs.",
      ],
    };

    const reportPath = join(outputDirectory, "browser-performance.json");
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.table(
      report.phases.map((phase) => ({
        phase: phase.name,
        runs: phase.samplesMs.length,
        minimumMs: phase.minimumMs.toFixed(2),
        medianMs: phase.medianMs.toFixed(2),
        maximumMs: phase.maximumMs.toFixed(2),
      })),
    );
    console.info("Environment:", JSON.stringify(report.environment));
    console.info(
      "PASS: Browser exports decoded after disposal; source preserved; zero active workers.",
    );
    console.info("PERFORMANCE_REPORT=" + reportPath);
  } finally {
    clearTimeout(timer);
    try {
      if (browser) await browser.close();
    } finally {
      await stopExampleServer(server);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error?.code ?? "BENCHMARK_FAILED", error?.message ?? "Benchmark failed.");
  process.exitCode = 1;
}
