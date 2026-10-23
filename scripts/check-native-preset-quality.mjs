import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { createMavio } from "../packages/mavio/dist/node.js";

function run(binary, args) {
  const result = spawnSync(binary, args, {
    shell: false,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr?.toString() || "Tool failed.");
  assert.equal(result.stderr.toString().trim(), "", "Unexpected tool diagnostics.");
  return result.stdout;
}

function decode(ffmpeg, path) {
  return run(ffmpeg, [
    "-hide_banner",
    "-v",
    "error",
    "-xerror",
    "-i",
    path,
    "-map",
    "0:v:0",
    "-an",
    "-sn",
    "-dn",
    "-c:v",
    "rawvideo",
    "-pix_fmt",
    "yuv420p",
    "-threads:v",
    "1",
    "-fps_mode:v",
    "passthrough",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
}

function lumaQuality(reference, actual, width, height, frames) {
  const pixels = width * height;
  const frameBytes = (pixels * 3) / 2;
  assert.equal(reference.length, frameBytes * frames);
  assert.equal(actual.length, reference.length);

  let squaredError = 0;
  for (let frame = 0; frame < frames; frame++) {
    const offset = frame * frameBytes;
    for (let pixel = 0; pixel < pixels; pixel++) {
      const difference = reference[offset + pixel] - actual[offset + pixel];
      squaredError += difference * difference;
    }
  }

  const mse = squaredError / (pixels * frames);
  const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  assert.ok(psnr === Infinity || Number.isFinite(psnr));
  return { mse, psnr };
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 0 || args.length === 2,
    "Provide no arguments or absolute FFmpeg and FFprobe paths.",
  );
  if (args.length === 2) assert.ok(args.every(isAbsolute));

  const [ffmpeg = "ffmpeg", ffprobe = "ffprobe"] = args;
  const directory = await mkdtemp(join(tmpdir(), "mavio-preset-quality-"));
  const fixtures = [];
  const outputs = [];
  const results = [];

  console.log("Quality environment:", {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    ffmpeg: run(ffmpeg, ["-version"]).toString().split(/\r?\n/)[0],
  });

  try {
    for (const [name, width, height] of [
      ["landscape-motion", 320, 180],
      ["portrait-motion", 180, 320],
    ]) {
      const path = join(directory, name + ".mp4");

      run(ffmpeg, [
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=" + width + "x" + height + ":rate=12:duration=1",
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-threads:v",
        "1",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        "-color_range",
        "tv",
        "-f",
        "mp4",
        path,
      ]);

      const report = JSON.parse(
        run(ffprobe, ["-v", "error", "-show_streams", "-of", "json", path]).toString(),
      );

      assert.equal(report.streams.length, 1);
      const video = report.streams[0];
      assert.equal(video.width, width);
      assert.equal(video.height, height);
      assert.equal(video.pix_fmt, "yuv420p");
      assert.equal(video.color_range, "tv");
      assert.equal(video.color_transfer, "bt709");
      assert.equal(video.color_primaries, "bt709");
      assert.equal(video.color_space, "bt709");

      const bytes = new Uint8Array(await readFile(path));
      fixtures.push({
        name,
        width,
        height,
        path,
        bytes,
        snapshot: bytes.slice(),
        reference: decode(ffmpeg, path),
      });
    }

    const client = createMavio({
      initTimeoutMs: 60_000,
      ...(args.length === 2
        ? {
            native: { ffmpegPath: ffmpeg, ffprobePath: ffprobe },
          }
        : {}),
    });

    try {
      for (const fixture of fixtures) {
        for (const preset of ["video-balanced-v1", "video-small-v1"]) {
          const result = await client
            .from({ kind: "bytes", bytes: fixture.bytes })
            .compress({ preset })
            .export({ format: "mp4", output: { kind: "bytes" } });

          assert.equal(result.output.kind, "bytes");
          const video = result.metadata.streams.find((stream) => stream.kind === "video");
          assert.equal(video.width, fixture.width);
          assert.equal(video.height, fixture.height);
          assert.equal(result.metadata.streams.length, 1);
          assert.equal(video.codec, "h264");
          assert.equal(result.metadata.sizeBytes, result.output.bytes.length);
          assert.deepEqual(fixture.bytes, fixture.snapshot);

          outputs.push({
            fixture,
            preset,
            bytes: result.output.bytes,
            snapshot: new Uint8Array(result.output.bytes),
          });
        }
      }
    } finally {
      await client.dispose();
    }

    for (const [index, output] of outputs.entries()) {
      assert.deepEqual(output.bytes, output.snapshot);
      const path = join(directory, "output-" + index + ".mp4");
      await writeFile(path, output.bytes);

      const decoded = decode(ffmpeg, path);
      const quality = lumaQuality(
        output.fixture.reference,
        decoded,
        output.fixture.width,
        output.fixture.height,
        12,
      );

      const minimumQuality = output.preset === "video-balanced-v1" ? 38 : 34;
      assert.ok(
        quality.psnr >= minimumQuality,
        "Luma quality regression on " +
          output.fixture.name +
          "/" +
          output.preset +
          ": measured " +
          quality.psnr +
          " dB; minimum " +
          minimumQuality +
          " dB.",
      );

      results.push({
        fixture: output.fixture.name,
        preset: output.preset,
        width: output.fixture.width,
        height: output.fixture.height,
        frames: 12,
        sourceBytes: output.fixture.bytes.length,
        outputBytes: output.bytes.length,
        minimumLumaPSNRdB: minimumQuality,
        lumaMSE: Number(quality.mse.toFixed(6)),
        lumaPSNRdB: quality.psnr === Infinity ? "identical" : Number(quality.psnr.toFixed(4)),
      });
    }

    for (const fixture of fixtures) {
      assert.deepEqual(fixture.bytes, fixture.snapshot);
      assert.deepEqual(new Uint8Array(await readFile(fixture.path)), fixture.snapshot);
    }

    assert.equal(results.length, 4);
    console.table(results);
    console.log("All four Native preset quality gates passed after client disposal.");
    console.log("Reference is the decoded source; this measures additional luma encoding error.");
    console.log("No subjective-quality certification or cross-runtime byte equality is implied.");
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("mavio-preset-quality-"));
    await rm(target, { recursive: true, force: true });
  }

  for (const output of outputs) {
    assert.deepEqual(output.bytes, output.snapshot);
  }
}

try {
  await main();
} catch (error) {
  console.error("Native preset quality check failed.");
  console.error(error);
  process.exitCode = 1;
}
