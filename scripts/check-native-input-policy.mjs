import { NATIVE_PROBE_INPUT_ARGUMENTS } from "../packages/mavio/dist/engines/native/input-policy.js";
import { captureNativeConfiguration } from "../packages/mavio/dist/engines/native/config.js";
import { discoverNativeTools } from "../packages/mavio/dist/engines/native/discovery.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMavio } from "../packages/mavio/dist/node.js";

function run(executable, args) {
  return execFileSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 1_048_576,
  });
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 0 || args.length === 2,
    "Provide no arguments or absolute FFmpeg and FFprobe paths.",
  );
  for (const tool of args) {
    assert.equal(resolve(tool), tool, "Use absolute tool paths.");
  }

  const configuration = captureNativeConfiguration(
    args.length === 0 ? {} : { ffmpegPath: args[0], ffprobePath: args[1] },
  );
  const tools = await discoverNativeTools(configuration, {
    jobId: "native-input-policy",
    signal: new AbortController().signal,
  });
  const { ffmpegPath: ffmpeg, ffprobePath: ffprobe } = tools;

  const directory = await mkdtemp(join(tmpdir(), "mavio-native-policy-"));
  const wavPath = join(directory, "neighbor.wav");
  const samples = 4800;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  await writeFile(wavPath, wav, { flag: "wx" });

  function generate(args) {
    run(ffmpeg, ["-hide_banner", "-v", "error", "-nostdin", "-n", ...args]);
  }

  const fixtures = [{ name: "WAV", path: wavPath, codec: "pcm_s16le" }];

  for (const [extension, encoder, codec] of [
    ["flac", "flac", "flac"],
    ["mp3", "libmp3lame", "mp3"],
  ]) {
    const path = join(directory, "source." + extension);
    generate(["-i", wavPath, "-c:a", encoder, path]);
    fixtures.push({ name: extension.toUpperCase(), path, codec });
  }

  const mp4Path = join(directory, "source.mp4");
  generate([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=12:duration=0.25",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    mp4Path,
  ]);
  fixtures.push({ name: "MP4", path: mp4Path, codec: "h264" });

  const mkvPath = join(directory, "source.mkv");
  generate(["-i", mp4Path, "-c", "copy", mkvPath]);
  fixtures.push({ name: "Matroska", path: mkvPath, codec: "h264" });

  for (const [extension, encoder] of [
    ["jpg", "mjpeg"],
    ["png", "png"],
  ]) {
    const path = join(directory, "source." + extension);
    generate([
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:size=160x90",
      "-frames:v",
      "1",
      "-c:v",
      encoder,
      "-threads",
      "1",
      "-update",
      "1",
      path,
    ]);
    fixtures.push({ name: extension.toUpperCase(), path, codec: encoder });
  }

  // Literal image filename policy: distinguish one file from sequence expansion.
  const imageBytes = await readFile(join(directory, "source.jpg"));
  const literalImage = join(directory, "sequence-%02d.jpg");
  await writeFile(literalImage, imageBytes, { flag: "wx" });
  await writeFile(join(directory, "sequence-01.jpg"), imageBytes, { flag: "wx" });
  await writeFile(join(directory, "sequence-02.jpg"), imageBytes, { flag: "wx" });

  const packetArgs = [
    "-count_packets",
    "-show_entries",
    "stream=nb_read_packets",
    "-of",
    "json",
    "-i",
    literalImage,
  ];

  const sequenceControl = JSON.parse(
    run(ffprobe, [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-f",
      "image2",
      "-pattern_type",
      "sequence",
      "-start_number",
      "1",
      ...packetArgs,
    ]),
  );
  assert.equal(Number(sequenceControl.streams[0].nb_read_packets), 2);

  const literalControl = JSON.parse(
    run(ffprobe, ["-v", "error", ...NATIVE_PROBE_INPUT_ARGUMENTS, "-f", "image2", ...packetArgs]),
  );
  assert.equal(Number(literalControl.streams[0].nb_read_packets), 1);

  fixtures.push({ name: "Literal image filename", path: literalImage, codec: "mjpeg" });
  console.info("PASS: image2 pattern expansion disabled; one literal file probed.");

  const manifest = Buffer.from("ffconcat version 1.0\nfile 'neighbor.wav'\n");
  const manifestPath = join(directory, "input.ffconcat");
  const disguisedPath = join(directory, "disguised.mp4");
  await writeFile(manifestPath, manifest, { flag: "wx" });
  await writeFile(disguisedPath, manifest, { flag: "wx" });

  // Positive control: unrestricted FFprobe really follows this local reference.
  const control = JSON.parse(
    run(ffprobe, [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      "-i",
      manifestPath,
    ]),
  );
  assert.equal(control.format.format_name, "concat");
  assert.equal(control.streams[0].codec_name, "pcm_s16le");

  const client = createMavio({
    native: { ffmpegPath: ffmpeg, ffprobePath: ffprobe },
  });
  const snapshots = new Map();

  try {
    const capabilities = await client.capabilities();
    for (const name of ["wav", "flac", "mp3", "mov", "matroska", "jpeg_pipe", "png_pipe"]) {
      assert.ok(capabilities.readableContainers.includes(name), "Missing format: " + name);
    }
    for (const name of ["concat", "hls", "dash"]) {
      assert.ok(!capabilities.readableContainers.includes(name));
    }

    for (const fixture of fixtures) {
      const bytes = await readFile(fixture.path);
      snapshots.set(fixture.path, Buffer.from(bytes));

      for (const input of [
        { kind: "path", path: fixture.path },
        { kind: "bytes", bytes },
      ]) {
        const metadata = await client.from(input).metadata();
        assert.ok(
          metadata.streams.some((stream) => stream.codec === fixture.codec),
          fixture.name + ": expected source codec",
        );
        assert.deepEqual(bytes, snapshots.get(fixture.path));
      }
      console.info("PASS: " + fixture.name + " metadata for path and bytes.");
    }

    const rejectedInputs = [
      { kind: "path", path: manifestPath },
      { kind: "path", path: disguisedPath },
      { kind: "bytes", bytes: manifest },
    ];

    for (const input of rejectedInputs) {
      await assert.rejects(client.from(input).metadata(), {
        code: "EXECUTION_FAILED",
        details: { reason: "NONZERO_EXIT", tool: "ffprobe" },
      });

      const recovered = await client.from({ kind: "path", path: wavPath }).metadata();
      assert.equal(recovered.streams[0].codec, "pcm_s16le");
    }

    await assert.rejects(
      client
        .from({ kind: "path", path: manifestPath })
        .compress({ preset: "audio-pcm-v1" })
        .export({ format: "wav", output: { kind: "bytes" } }),
      {
        code: "EXECUTION_FAILED",
        details: { reason: "NONZERO_EXIT", tool: "ffprobe" },
      },
    );

    const recovered = await client.from({ kind: "path", path: wavPath }).metadata();
    assert.equal(recovered.streams[0].sampleRate, 48000);
  } finally {
    await client.dispose();
  }

  for (const [path, snapshot] of snapshots) {
    assert.deepEqual(await readFile(path), snapshot);
  }
  assert.deepEqual(await readFile(manifestPath), manifest);
  assert.deepEqual(await readFile(disguisedPath), manifest);
  assert.deepEqual(await readFile(wavPath), wav);

  console.info("PASS: Concat rejected for path, disguised extension, bytes, and export.");
  console.info("PASS: Same-client recovery, disposal, and source preservation.");
  console.info("This check does not establish general filesystem confinement.");
  console.info("NATIVE_POLICY_FIXTURE_DIRECTORY=" + directory);
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
