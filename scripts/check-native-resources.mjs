import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as idle } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
  });
}

async function main() {
  assert.equal(process.argv.length, 5, "Provide FFmpeg, FFprobe, and fixture paths.");
  assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc.");

  const [ffmpegPath, ffprobePath, fixturePath] = process.argv.slice(2).map(resolvePath);
  function resolvePath(value) {
    return resolve(value);
  }
  for (const path of [ffmpegPath, ffprobePath, fixturePath]) {
    assert.ok(existsSync(path), "Missing path: " + path);
  }

  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "Run through npm run check:resources:native.");
  const directory = mkdtempSync(join(tmpdir(), "mavio-native-resources-"));
  const consumer = join(directory, "consumer");
  const sdkTemporary = join(directory, "sdk-temporary");
  const verification = join(directory, "verification");
  for (const path of [consumer, sdkTemporary, verification]) mkdirSync(path);

  const npm = (args, cwd = root) => run(process.execPath, [npmCli, ...args], cwd);
  const [packed] = JSON.parse(
    npm([
      "pack",
      "--workspace=@vormirtech/mavio",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      directory,
    ]),
  );
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "mavio-resource-consumer",
      private: true,
      type: "module",
    }),
  );
  npm(
    ["install", join(directory, packed.filename), "--ignore-scripts", "--no-audit", "--no-fund"],
    consumer,
  );

  const inputMetadata = JSON.parse(
    run(ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", fixturePath]),
  );
  const video = inputMetadata.streams.find((stream) => stream.codec_type === "video");
  assert.equal(video?.width, 320, "Use the controlled 320x240 fixture.");
  assert.equal(video?.height, 240);
  assert.ok(Math.abs(Number(inputMetadata.format.duration) - 3) < 0.05);

  const fixture = readFileSync(fixturePath);
  const inputBytes = new Uint8Array(fixture);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const fixtureHash = hash(fixture);

  // Scope SDK/tool temporary files to a new directory in this driver process.
  process.env.TMPDIR = sdkTemporary;
  process.env.TEMP = sdkTemporary;
  process.env.TMP = sdkTemporary;

  const requireConsumer = createRequire(join(consumer, "package.json"));
  const entry = requireConsumer.resolve("@vormirtech/mavio/node");
  assert.equal(
    realpathSync(entry),
    realpathSync(join(consumer, "node_modules/@vormirtech/mavio/dist/node.js")),
  );
  const { createMavio, SDK_VERSION } = await import(pathToFileURL(entry).href);
  const lock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));

  const activeProcesses = new Set();
  let processesCreated = 0;
  let peakProcesses = 0;
  const hook = createHook({
    init(id, type) {
      if (type === "PROCESSWRAP") {
        activeProcesses.add(id);
        processesCreated++;
        peakProcesses = Math.max(peakProcesses, activeProcesses.size);
      }
    },
    destroy(id) {
      activeProcesses.delete(id);
    },
  });

  async function settled() {
    for (let turn = 0; turn < 20; turn++) {
      await idle();
      if (activeProcesses.size === 0) break;
    }
    assert.equal(activeProcesses.size, 0, "A tracked process resource remains active.");
    assert.deepEqual(readdirSync(sdkTemporary), [], "SDK temporary files remain.");
  }

  const snapshots = [];
  async function snapshot(label) {
    await settled();
    const beforeGc = process.memoryUsage();
    globalThis.gc();
    await idle();
    globalThis.gc();
    await idle();
    const afterGc = process.memoryUsage();
    snapshots.push({
      label,
      beforeGc,
      afterGc,
      activeProcessWrappers: activeProcesses.size,
      sdkTemporaryEntries: readdirSync(sdkTemporary).length,
    });
  }

  const counts = {
    exports: 0,
    invalidMedia: 0,
    preExecutionCancellation: 0,
    recoveryMetadata: 0,
    freshClientCycles: 0,
  };
  const retained = [];
  let client;

  hook.enable();
  try {
    // Verify that this runtime exposes child processes through PROCESSWRAP.
    await new Promise((accept, reject) => {
      const child = spawn(process.execPath, ["-e", ""], {
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) accept();
        else reject(new Error("Process-tracking calibration failed."));
      });
    });
    await settled();
    assert.equal(processesCreated, 1, "Process tracking did not observe calibration.");

    client = createMavio({ native: { ffmpegPath, ffprobePath } });
    await client.capabilities();
    await client.from({ kind: "bytes", bytes: inputBytes }).metadata();
    await snapshot("after warmup");

    for (let batch = 0; batch < 5; batch++) {
      for (let index = 0; index < 5; index++) {
        await (async () => {
          const source = client.from(
            index % 2 === 0
              ? { kind: "bytes", bytes: inputBytes, name: "input.mp4" }
              : { kind: "path", path: fixturePath },
          );
          const result = await source
            .convert({ format: "mp4", preset: "video-balanced-v1" })
            .export({ output: { kind: "bytes" } });

          const number = counts.exports++;
          writeFileSync(join(verification, "output-" + number + ".mp4"), result.output.bytes);
          if (number === 0 || number === 24) {
            retained.push({ bytes: result.output.bytes, sha256: hash(result.output.bytes) });
          }
        })();
        await settled();
      }

      await assert.rejects(
        client.from({ kind: "bytes", bytes: new Uint8Array([1, 2, 3]) }).metadata(),
        { code: "EXECUTION_FAILED", details: { reason: "NONZERO_EXIT", tool: "ffprobe" } },
      );
      counts.invalidMedia++;
      await settled();

      const controller = new AbortController();
      await assert.rejects(
        client
          .from({ kind: "bytes", bytes: inputBytes })
          .convert({ format: "mp4", preset: "video-balanced-v1" })
          .export(
            { output: { kind: "bytes" } },
            {
              signal: controller.signal,
              onProgress(event) {
                // Cancel after admission, before execute starts.
                if (event.stage === "running") controller.abort();
              },
            },
          ),
        { code: "CANCELLED" },
      );
      counts.preExecutionCancellation++;
      await settled();

      await client.from({ kind: "bytes", bytes: inputBytes }).metadata();
      counts.recoveryMetadata++;
      await snapshot("after batch " + (batch + 1));
    }

    await client.dispose();
    client = undefined;
    await snapshot("after primary client disposal");

    for (let index = 0; index < 5; index++) {
      client = createMavio({ native: { ffmpegPath, ffprobePath } });
      await client.from({ kind: "bytes", bytes: inputBytes }).metadata();
      await client.dispose();
      client = undefined;
      counts.freshClientCycles++;
      await settled();
    }
    await snapshot("after five fresh-client cycles");

    for (const output of retained) assert.equal(hash(output.bytes), output.sha256);
    const retainedByteCount = retained.reduce((sum, output) => sum + output.bytes.byteLength, 0);
    retained.length = 0;
    await snapshot("after releasing retained output references");

    assert.equal(hash(inputBytes), fixtureHash);
    assert.equal(hash(readFileSync(fixturePath)), fixtureHash);
    assert.ok(processesCreated > 1);

    hook.disable();

    for (let index = 0; index < counts.exports; index++) {
      const output = join(verification, "output-" + index + ".mp4");
      const metadata = JSON.parse(
        run(ffprobePath, ["-v", "error", "-show_streams", "-of", "json", output]),
      );
      assert.ok(
        metadata.streams.some(
          (stream) => stream.codec_type === "video" && stream.codec_name === "h264",
        ),
      );
      run(ffmpegPath, ["-hide_banner", "-v", "error", "-xerror", "-i", output, "-f", "null", "-"]);
    }

    const report = {
      recordedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpu: cpus()[0]?.model,
        sdkVersion: SDK_VERSION,
        sdkArchiveIntegrity: lock.packages["node_modules/@vormirtech/mavio"].integrity,
      },
      fixture: { sha256: fixtureHash, sizeBytes: fixture.byteLength },
      counts,
      resources: {
        processTrackingCalibrationPassed: true,
        sdkProcessWrappersCreated: processesCreated - 1,
        peakTrackedProcessWrappers: peakProcesses,
        finalActiveProcessWrappers: activeProcesses.size,
        finalSdkTemporaryEntries: readdirSync(sdkTemporary).length,
        retainedOutputBytesVerifiedAfterDisposal: retainedByteCount,
        decodedOutputsAfterDisposal: counts.exports,
        sourceFileAndBytesUnchanged: true,
        invalidInputRejection: {
          code: "EXECUTION_FAILED",
          reason: "NONZERO_EXIT",
          tool: "ffprobe",
        },
      },
      snapshots,
      limitations: [
        "Bounded small-fixture investigation; no universal leak or file-size guarantee.",
        "Memory samples cover this Node process, not FFmpeg child-process RSS.",
        "Before/after explicit GC samples are observations, not normal GC scheduling.",
        "PROCESSWRAP tracking is calibrated but is not a system-wide process inventory.",
        "Cancellation is admitted pre-execution cancellation, not active encoder interruption.",
        "Twenty-five output files are deliberately retained in a separate verification directory.",
      ],
    };

    const reportPath = join(directory, "native-resources.json");
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.table(
      snapshots.map((sample) => ({
        checkpoint: sample.label,
        rssMiB: (sample.afterGc.rss / 1048576).toFixed(2),
        heapMiB: (sample.afterGc.heapUsed / 1048576).toFixed(2),
        externalMiB: (sample.afterGc.external / 1048576).toFixed(2),
        arrayBuffersKiB: (sample.afterGc.arrayBuffers / 1024).toFixed(2),
        processes: sample.activeProcessWrappers,
        temporaryEntries: sample.sdkTemporaryEntries,
      })),
    );
    console.info("Counts:", JSON.stringify(counts));
    console.info("Resources:", JSON.stringify(report.resources));
    console.info("PASS: bounded Native process/workspace checks and output decoding.");
    console.info("Memory trend still requires review; no memory threshold was asserted.");
    console.info("RESOURCE_REPORT=" + reportPath);
  } finally {
    try {
      if (client) await client.dispose();
    } finally {
      hook.disable();
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error?.code ?? "RESOURCE_CHECK_FAILED", error?.message ?? "Resource check failed.");
  process.exitCode = 1;
}
