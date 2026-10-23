import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

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
    "Provide installed consumer directory, FFmpeg, FFprobe, and fixture paths.",
  );

  const [consumer, ffmpegPath, ffprobePath, fixturePath] = process.argv
    .slice(2)
    .map((value) => resolve(value));

  for (const path of [consumer, ffmpegPath, ffprobePath, fixturePath]) {
    assert.ok(existsSync(path), "Missing path: " + path);
  }

  const consumerRequire = createRequire(join(consumer, "package.json"));
  const entry = consumerRequire.resolve("@vormir/mavio/node");
  assert.equal(
    realpathSync(entry),
    realpathSync(join(consumer, "node_modules/@vormir/mavio/dist/node.js")),
  );

  const { createMavio, SDK_VERSION } = await import(pathToFileURL(entry).href);
  const outputDirectory = mkdtempSync(join(tmpdir(), "mavio-native-benchmark-"));

  const input = JSON.parse(
    run(ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", fixturePath]),
  );

  const fixtureBytes = readFileSync(fixturePath);
  const lockPath = join(consumer, "package-lock.json");
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : undefined;

  const report = {
    recordedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      architecture: arch(),
      osRelease: release(),
      cpu: cpus()[0]?.model,
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      sdkVersion: SDK_VERSION,
      sdkArchiveIntegrity: lock?.packages?.["node_modules/@vormir/mavio"]?.integrity,
      ffmpeg: run(ffmpegPath, ["-version"]).split(/\r?\n/)[0],
      ffprobe: run(ffprobePath, ["-version"]).split(/\r?\n/)[0],
    },
    fixture: {
      sha256: createHash("sha256").update(fixtureBytes).digest("hex"),
      sizeBytes: fixtureBytes.byteLength,
      durationSeconds: Number(input.format.duration),
      streams: input.streams.map((stream) => ({
        kind: stream.codec_type,
        codec: stream.codec_name,
        width: stream.width,
        height: stream.height,
        frameRate: stream.avg_frame_rate,
        sampleRate: stream.sample_rate,
        channels: stream.channels,
        pixelFormat: stream.pix_fmt,
        colorSpace: stream.color_space,
        colorTransfer: stream.color_transfer,
        colorPrimaries: stream.color_primaries,
      })),
    },
    phases: [],
    verification: {},
    limitations: [
      "Local observations; no performance guarantee or acceptance threshold.",
      "Fresh client does not mean cold OS caches or a cold machine.",
      "Warm native exports still launch new FFmpeg processes.",
      "Export timing excludes subsequent file writing and independent decoding.",
      "Progress and diagnostics observers are disabled for these timings.",
      "This benchmark does not measure memory or native child-process RSS.",
    ],
  };

  async function withClient(work) {
    const client = createMavio({
      native: { ffmpegPath, ffprobePath },
    });
    let value;
    let failed = false;
    let primary;

    try {
      value = await work(client);
    } catch (error) {
      failed = true;
      primary = error;
    }

    try {
      await client.dispose();
    } catch (error) {
      if (!failed) throw error;
      console.error("Cleanup also failed; the primary benchmark error is retained.");
    }

    if (failed) throw primary;
    return value;
  }

  function summarize(name, samplesMs) {
    const sorted = [...samplesMs].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return {
      name,
      samplesMs,
      minimumMs: sorted[0],
      medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
      maximumMs: sorted.at(-1),
    };
  }

  async function measure(name, count, work) {
    const samples = [];
    for (let index = 0; index < count; index++) {
      const started = performance.now();
      await work(index);
      samples.push(performance.now() - started);
    }
    report.phases.push(summarize(name, samples));
  }

  // Measure capabilities only; exclude client creation and disposal.
  const initializationSamples = [];
  for (let index = 0; index < 3; index++) {
    await withClient(async (client) => {
      const started = performance.now();
      await client.capabilities();
      initializationSamples.push(performance.now() - started);
    });
  }
  report.phases.push(summarize("fresh-client capabilities", initializationSamples));

  const exports = [];

  await withClient(async (client) => {
    await client.capabilities();
    const source = client.from({ kind: "path", path: fixturePath });

    // Prime the metadata path before recording warm metadata requests.
    await source.metadata();

    await measure("warm-client capabilities", 5, () => client.capabilities());
    await measure("warm-client metadata", 5, () => source.metadata());
    await measure("warm-client balanced MP4 byte export", 3, async () => {
      const result = await source
        .convert({ format: "mp4", preset: "video-balanced-v1" })
        .export({ output: { kind: "bytes" } });
      assert.equal(result.output.kind, "bytes");
      exports.push(result.output.bytes);
    });
  });

  for (const [index, bytes] of exports.entries()) {
    const output = join(outputDirectory, "export-" + index + ".mp4");
    writeFileSync(output, bytes);

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

  assert.equal(
    createHash("sha256").update(readFileSync(fixturePath)).digest("hex"),
    report.fixture.sha256,
    "Source fixture changed.",
  );

  report.verification = {
    decodedExportsAfterDisposal: exports.length,
    sourceUnchanged: true,
  };

  const reportPath = join(outputDirectory, "native-performance.json");
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
  console.info("PASS: exports independently decoded after disposal; source unchanged.");
  console.info("PERFORMANCE_REPORT=" + reportPath);
}

try {
  await main();
} catch (error) {
  console.error(error?.code ?? "BENCHMARK_FAILED", error?.message ?? "Benchmark failed.");
  process.exitCode = 1;
}
