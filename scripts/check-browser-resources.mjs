import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { startExampleServer, stopExampleServer } from "./example-server.mjs";
import { installResourceObserver, instrumentResourceWorker } from "./browser-resource-observer.mjs";

function run(executable, args) {
  return execFileSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function probe(ffprobe, path) {
  return JSON.parse(
    run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]),
  );
}

async function main() {
  assert.equal(
    process.argv.length,
    6,
    "Provide Browser consumer directory, FFmpeg, FFprobe, and fixture.",
  );

  const [consumer, ffmpeg, ffprobe, fixturePath] = process.argv
    .slice(2)
    .map((value) => resolve(value));

  for (const path of [consumer, ffmpeg, ffprobe, fixturePath]) {
    assert.ok(existsSync(path), "Missing path: " + path);
  }

  const name = basename(consumer);
  assert.ok(["vanilla-js", "vanilla-ts"].includes(name));

  const consumerRequire = createRequire(join(consumer, "package.json"));
  assert.equal(
    realpathSync(consumerRequire.resolve("@vormir/mavio/browser")),
    realpathSync(join(consumer, "node_modules/@vormir/mavio/dist/browser.js")),
  );

  const publicDirectory = join(consumer, "public");
  const engineDirectory = join(publicDirectory, "mavio-engine");
  const manifest = JSON.parse(readFileSync(join(engineDirectory, "manifest.json"), "utf8"));

  const kitPins = JSON.parse(
    readFileSync(
      join(consumer, "node_modules/@vormir/mavio/scripts/browser-engine-kit-pins.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.candidateId, kitPins.candidateId);
  assert.equal(manifest.ffmpegVersion, "5.1.10");
  for (const [asset, expected] of Object.entries(manifest.files)) {
    assert.equal(sha256(readFileSync(join(engineDirectory, asset))), expected, asset);
  }
  for (const [asset, expected] of Object.entries(kitPins.files)) {
    if (!asset.startsWith("core/")) assert.equal(manifest.files[asset], expected, asset);
  }
  assert.equal(manifest.correction, "restore-stack-after-native-entry-v1");
  assert.equal(manifest.wrapperVersion, "0.12.15");
  assert.equal(
    sha256(readFileSync(join(engineDirectory, "ffmpeg-core.wasm"))),
    kitPins.files["core/ffmpeg-core.wasm"],
  );

  const sdk = JSON.parse(
    readFileSync(join(consumer, "node_modules/@vormir/mavio/package.json"), "utf8"),
  );
  const lock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
  const fixture = readFileSync(fixturePath);
  const input = probe(ffprobe, fixturePath);
  const inputVideo = input.streams.find((stream) => stream.codec_type === "video");

  assert.equal(inputVideo?.width, 320);
  assert.equal(inputVideo?.height, 240);
  assert.ok(Math.abs(Number(input.format.duration) - 3) < 0.2);

  const id = "m6-resources-" + randomUUID();
  const originalWorkerPath = join(engineDirectory, "wrapper/worker.js");
  const originalWorker = readFileSync(originalWorkerPath, "utf8");
  const instrumentedWorker = instrumentResourceWorker(originalWorker);
  const workerName = id + "-worker.js";

  writeFileSync(join(engineDirectory, "wrapper", workerName), instrumentedWorker, { flag: "wx" });

  const bundle = await build({
    stdin: {
      contents: readFileSync(new URL("./browser-resource-entry.mjs", import.meta.url), "utf8"),
      resolveDir: consumer,
      sourcefile: "browser-resource-entry.mjs",
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
  writeFileSync(join(publicDirectory, id + ".js"), bundle.outputFiles[0].contents, {
    flag: "wx",
  });
  writeFileSync(join(publicDirectory, id + ".mp4"), fixture, { flag: "wx" });

  const outputDirectory = mkdtempSync(join(tmpdir(), "mavio-browser-resources-"));
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
    await page.addInitScript(installResourceObserver);
    await page.goto(server.origin);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("HeapProfiler.enable");

    const checkpoints = [];
    const batches = [];

    async function invoke(method, args = []) {
      return page.evaluate(
        async ({ id, method, args }) => {
          const workload = await import("/" + id + ".js");
          return workload[method](...args);
        },
        { id, method, args },
      );
    }

    async function checkpoint(label, expectedWorkers) {
      const resources = await page.evaluate(() => globalThis.__mavioResourceObserver.snapshot());

      assert.equal(resources.activeWorkers, expectedWorkers);
      assert.equal(resources.workspaceDirectories, 0);
      assert.equal(resources.workspaceEntries, 0);
      assert.equal(resources.pendingFilesystemRequests, 0);
      assert.equal(resources.trackedWorkspaceDirectories, 0);
      assert.equal(resources.filesystemErrors, 0);

      if (expectedWorkers > 0) {
        assert.ok(resources.wasmHeapBytes > 0);
      } else {
        assert.equal(resources.wasmHeapBytes, 0);
      }

      const beforeGC = await cdp.send("Runtime.getHeapUsage");
      await cdp.send("HeapProfiler.collectGarbage");
      const afterGC = await cdp.send("Runtime.getHeapUsage");

      checkpoints.push({
        checkpoint: label,
        pageHeapBeforeGC: beforeGC,
        pageHeapAfterGC: afterGC,
        ...resources,
      });
    }

    async function investigate() {
      const initialization = await invoke("initializeResourceRun", [
        "/" + id + ".mp4",
        "/mavio-engine/wrapper/" + workerName,
      ]);
      assert.equal(initialization.sourceSHA256, sha256(fixture));

      await checkpoint("after warmup", 1);

      for (let batch = 1; batch <= 5; batch += 1) {
        batches.push(await invoke("runResourceBatch", [batch]));
        await checkpoint("after batch " + batch, 1);
      }

      const disposal = await invoke("disposeResourceRun");
      assert.equal(disposal.retainedOutputs, 25);
      assert.equal(disposal.outputHashesVerifiedAfterDisposal, true);
      assert.equal(disposal.sourceUnchanged, true);
      await checkpoint("after primary client disposal", 0);

      const fresh = await invoke("runFreshClientCycles");
      assert.equal(fresh.freshClientCycles, 5);
      await checkpoint("after five fresh-client cycles", 0);

      const outputs = await invoke("collectResourceOutputs");
      assert.equal(outputs.length, 25);

      await invoke("releaseResourceOutputs");
      await checkpoint("after releasing retained output references", 0);

      return { initialization, disposal, fresh, outputs };
    }

    const measured = await Promise.race([
      investigate(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Browser resource investigation exceeded eight minutes.")),
          480_000,
        );
      }),
    ]);
    clearTimeout(timer);

    const final = checkpoints.at(-1);
    assert.ok(final.workspaceCreates > 0, "Filesystem observation was not exercised.");
    assert.equal(final.dispatchedCancellations, 5);
    assert.equal(final.workersCreated, final.workersTerminated);
    assert.deepEqual(pageErrors, []);

    for (const output of measured.outputs) {
      const bytes = Buffer.from(output.bytes);
      assert.equal(sha256(bytes), output.sha256);

      const path = join(outputDirectory, `export-${output.batch}-${output.index}.mp4`);
      writeFileSync(path, bytes, { flag: "wx" });

      const metadata = probe(ffprobe, path);
      const video = metadata.streams.find((stream) => stream.codec_type === "video");

      assert.equal(video?.codec_name, "h264");
      assert.equal(video.width, inputVideo.width);
      assert.equal(video.height, inputVideo.height);

      if (input.streams.some((stream) => stream.codec_type === "audio")) {
        assert.ok(metadata.streams.some((stream) => stream.codec_type === "audio"));
      }

      run(ffmpeg, ["-hide_banner", "-v", "error", "-xerror", "-i", path, "-f", "null", "-"]);
    }

    assert.equal(sha256(readFileSync(fixturePath)), sha256(fixture));
    assert.equal(readFileSync(originalWorkerPath, "utf8"), originalWorker);

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
        sdkArchiveIntegrity: lock.packages?.["node_modules/@vormir/mavio"]?.integrity,
        candidateId: manifest.candidateId,
        ffmpegVersion: manifest.ffmpegVersion,
        wrapperVersion: manifest.wrapperVersion,
      },
      fixture: {
        sha256: sha256(fixture),
        sizeBytes: fixture.byteLength,
        durationSeconds: Number(input.format.duration),
        width: inputVideo.width,
        height: inputVideo.height,
      },
      instrumentation: {
        originalWorkerSHA256: sha256(originalWorker),
        instrumentedWorkerSHA256: sha256(instrumentedWorker),
        originalWorkerUnchanged: true,
        purpose: "Read-only workspace enumeration and WASM capacity snapshots.",
      },
      checkpoints,
      counts: {
        exports: 25,
        invalidMedia: 5,
        executionDispatchCancellation: 5,
        recoveryMetadata: 5,
        freshClientCycles: 5,
      },
      verification: {
        ...measured.disposal,
        decodedOutputsAfterDisposal: measured.outputs.length,
        finalActiveWorkers: final.activeWorkers,
        finalWorkspaceDirectories: final.workspaceDirectories,
        finalWorkspaceEntries: final.workspaceEntries,
        workspaceCreates: final.workspaceCreates,
        workspaceDeletes: final.workspaceDeletes,
        workspaceDirectoriesDestroyedByTermination:
          final.workspaceDirectoriesDestroyedByTermination,
      },
      limitations: [
        "Short local investigation; no memory threshold or leak-free guarantee.",
        "CDP heap measurements cover the page isolate, excluding worker isolates.",
        "WASM heap bytes measure linear-memory capacity, not live allocation.",
        "No total browser RSS or worker JavaScript heap measurement.",
        "Cancellation follows EXEC dispatch; encoding progress is not established.",
        "The test worker has an additional read-only snapshot message handler.",
        "Worker tracking observes creation and terminate calls.",
        "Retained outputs intentionally contribute to page memory until released.",
      ],
    };

    const reportPath = join(outputDirectory, "browser-resources.json");
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");

    console.table(
      checkpoints.map((row) => ({
        checkpoint: row.checkpoint,
        pageHeapMiB: (row.pageHeapAfterGC.usedSize / 1048576).toFixed(2),
        wasmCapacityMiB: (row.wasmHeapBytes / 1048576).toFixed(2),
        workers: row.activeWorkers,
        directories: row.workspaceDirectories,
        entries: row.workspaceEntries,
      })),
    );
    console.info("Counts:", JSON.stringify(report.counts));
    console.info("Resources:", JSON.stringify(report.verification));
    console.info("PASS: Browser resource checks and 25 post-disposal output decodes.");
    console.info("Memory observations require review; no memory threshold was asserted.");
    console.info("RESOURCE_REPORT=" + reportPath);
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
  console.error(error);
  process.exitCode = 1;
}
