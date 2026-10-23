import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(executable, args, timeout = 120_000) {
  try {
    const output = execFileSync(executable, args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (output) process.stdout.write(output);
    return output;
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}

function marker(output, name) {
  const matches = output.split(/\r?\n/).filter((line) => line.startsWith(name + "="));

  assert.equal(matches.length, 1, "Expected one " + name + " marker.");
  const value = matches[0].slice(name.length + 1).trim();
  assert.ok(existsSync(value), "Missing reported path: " + value);
  return value;
}

function main() {
  assert.equal(process.argv.length, 4, "Provide absolute FFmpeg and FFprobe paths.");
  const [ffmpeg, ffprobe] = process.argv.slice(2);

  for (const executable of [ffmpeg, ffprobe]) {
    assert.equal(resolve(executable), executable, "Use absolute tool paths.");
    assert.ok(existsSync(executable), "Missing executable: " + executable);
  }

  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "Run through npm run check:m6.");

  const directory = mkdtempSync(join(tmpdir(), "mavio-m6-"));
  const fixture = join(directory, "fixture.mp4");

  console.info("Creating controlled M6 fixture.");
  run(ffmpeg, [
    "-hide_banner",
    "-v",
    "error",
    "-nostdin",
    "-n",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x240:rate=24:duration=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=3",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-vf",
    "setsar=1,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-x264-params",
    "colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-color_range",
    "tv",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    "-t",
    "3",
    fixture,
  ]);

  const metadata = JSON.parse(
    run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", fixture]),
  );
  const video = metadata.streams.find((stream) => stream.codec_type === "video");
  const audio = metadata.streams.find((stream) => stream.codec_type === "audio");

  assert.equal(video?.codec_name, "h264");
  assert.equal(video.width, 320);
  assert.equal(video.height, 240);
  assert.equal(video.pix_fmt, "yuv420p");
  assert.equal(video.sample_aspect_ratio, "1:1");
  assert.equal(video.avg_frame_rate, "24/1");
  assert.equal(video.color_primaries, "bt709");
  assert.equal(video.color_transfer, "bt709");
  assert.equal(video.color_space, "bt709");
  assert.equal(video.color_range, "tv");
  assert.equal(audio?.codec_name, "aac");
  assert.equal(audio.sample_rate, "48000");
  assert.equal(audio.channels, 1);
  assert.ok(Math.abs(Number(metadata.format.duration) - 3) < 0.2);

  run(ffmpeg, [
    "-hide_banner",
    "-v",
    "error",
    "-nostdin",
    "-xerror",
    "-i",
    fixture,
    "-f",
    "null",
    "-",
  ]);
  console.info("PASS: M6 fixture profile and independent decoding.");

  console.info("Starting all three installed-package examples.");
  const examplesOutput = run(
    process.execPath,
    [npmCli, "run", "check:examples", "--", ffmpeg, ffprobe, fixture],
    900_000,
  );
  const examples = marker(examplesOutput, "EXAMPLES_CONSUMER_DIRECTORY");

  console.info("Starting fresh-package Native resource investigation.");
  const nativeOutput = run(
    process.execPath,
    [npmCli, "run", "check:resources:native", "--", ffmpeg, ffprobe, fixture],
    900_000,
  );
  copyFileSync(marker(nativeOutput, "RESOURCE_REPORT"), join(directory, "native-resources.json"));

  console.info("Starting installed-package Browser resource investigation.");
  const browserOutput = run(
    process.execPath,
    [
      join(root, "scripts/check-browser-resources.mjs"),
      join(examples, "vanilla-ts"),
      ffmpeg,
      ffprobe,
      fixture,
    ],
    900_000,
  );
  copyFileSync(marker(browserOutput, "RESOURCE_REPORT"), join(directory, "browser-resources.json"));

  console.info("PASS: M6 examples and bounded resource investigations.");
  console.info("M6_REPORT_DIRECTORY=" + directory);
}

try {
  main();
} catch (error) {
  console.error(error?.message ?? error);
  process.exitCode = 1;
}
