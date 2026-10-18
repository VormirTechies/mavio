import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runNativeProcess } from "../packages/mavio/dist/engines/native/process.js";

// Specific to the two-second, 320×180, 24 fps, 48 kHz mono fixture.
export async function checkNativeTrimResize({
  configuration,
  tools,
  client,
  mediaPath,
  directory,
  context,
  preset = "video-balanced-v1",
}) {
  assert.ok(preset === "video-balanced-v1" || preset === "video-small-v1");

  const inputBytes = new Uint8Array(await readFile(mediaPath));
  const inputSnapshot = inputBytes.slice();

  const result = await client
    .from({ kind: "bytes", bytes: inputBytes, name: "combined source.mp4" })
    .resize({ width: 160, height: 90 })
    .trim({ start: 0.51, end: 1.49 })
    .resize({ width: 320, height: 180 })
    .compress({ preset })
    .export({ format: "mp4", output: { kind: "bytes" } }, { signal: context.signal });

  assert.equal(result.output.kind, "bytes");
  assert.ok(result.output.bytes.byteLength > 0);
  assert.equal(result.metadata.sizeBytes, result.output.bytes.byteLength);
  assert.equal(result.warnings?.length ?? 0, 0);
  assert.deepEqual(inputBytes, inputSnapshot);

  const video = result.metadata.streams.find((stream) => stream.kind === "video");

  assert.ok(video);
  assert.equal(video.width, 160);
  assert.equal(video.height, 90);

  const outputSnapshot = result.output.bytes.slice();

  // Reuse returned bytes after the export's workspace cleanup.
  const metadata = await client
    .from({
      kind: "bytes",
      bytes: result.output.bytes,
      name: "combined output.mp4",
    })
    .metadata({ signal: context.signal });

  assert.deepEqual(metadata, result.metadata);

  const outputPath = join(directory, `public trim and resize ${preset}.mp4`);
  await writeFile(outputPath, result.output.bytes, { flag: "wx" });

  const probe = await runNativeProcess({
    executable: tools.ffprobe.path,
    cwd: configuration.cwd,
    signal: context.signal,
    maxOutputBytes: 1_048_576,
    args: [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-show_streams",
      "-show_frames",
      "-show_entries",
      "stream=codec_type,codec_name,sample_rate,channels,sample_aspect_ratio,time_base,start_pts,duration_ts:frame=media_type,width,height,best_effort_timestamp_time,nb_samples",
      "-of",
      "json",
      "-i",
      outputPath,
    ],
  });

  assert.equal(probe.stderr.trim(), "");

  const details = JSON.parse(probe.stdout);
  assert.ok(Array.isArray(details.streams));
  assert.ok(Array.isArray(details.frames));
  assert.equal(details.streams.length, 2);

  const videoStream = details.streams.find((stream) => stream.codec_type === "video");
  const audioStream = details.streams.find((stream) => stream.codec_type === "audio");

  assert.ok(videoStream);
  assert.ok(audioStream);
  assert.equal(videoStream.codec_name, "h264");
  assert.equal(videoStream.sample_aspect_ratio, "1:1");
  assert.equal(audioStream.codec_name, "aac");
  assert.equal(audioStream.sample_rate, "48000");
  assert.equal(audioStream.channels, 1);

  function timestamp(frame) {
    assert.equal(typeof frame.best_effort_timestamp_time, "string");
    assert.notEqual(frame.best_effort_timestamp_time.trim(), "");

    const value = Number(frame.best_effort_timestamp_time);
    assert.ok(Number.isFinite(value));
    return value;
  }

  const videoFrames = details.frames.filter((frame) => frame.media_type === "video");
  const audioFrames = details.frames.filter((frame) => frame.media_type === "audio");

  assert.equal(videoFrames.length, 23);
  assert.ok(audioFrames.length > 0);

  for (const [index, frame] of videoFrames.entries()) {
    assert.equal(frame.width, 160);
    assert.equal(frame.height, 90);

    const expected = (13 + index) / 24 - 0.51;
    assert.ok(
      Math.abs(timestamp(frame) - expected) <= 0.000003,
      `Combined output video timestamp mismatch at frame ${index}`,
    );
  }

  let audioSamples = 0;

  for (const frame of audioFrames) {
    assert.ok(Number.isSafeInteger(frame.nb_samples));
    assert.ok(frame.nb_samples > 0);
    assert.ok(
      Math.abs(timestamp(frame) - audioSamples / 48000) <= 0.000002,
      "Combined output audio contains a timestamp gap or overlap",
    );

    audioSamples += frame.nb_samples;
  }

  const requestedSamples = 47_040;
  const finalFrame = audioFrames.at(-1);
  const extraSamples = audioSamples - requestedSamples;

  console.log(`${preset}: combined AAC timing`, {
    ffmpegVersion: tools.ffmpeg.version,
    ffprobeVersion: tools.ffprobe.version,
    requestedSamples,
    declaredSamples: audioStream.duration_ts,
    decodedSamples: audioSamples,
    extraSamples,
  });

  // The intended presentation interval must remain exact.
  assert.equal(audioStream.time_base, "1/48000");
  assert.equal(audioStream.start_pts, 0);
  assert.equal(
    audioStream.duration_ts,
    requestedSamples,
    `${preset}: MP4 declares an incorrect audio duration`,
  );

  assert.ok(finalFrame);
  assert.ok(
    audioSamples >= requestedSamples,
    `${preset}: decoded audio is shorter than the requested interval`,
  );

  if (extraSamples !== 0) {
    // This allowance is specific to this known AAC fixture.
    // The existing loop already checks timestamp continuity from zero.
    assert.equal(
      audioSamples,
      Math.ceil(requestedSamples / 1024) * 1024,
      `${preset}: decoded length is not the expected final-frame boundary`,
    );

    assert.ok(
      audioFrames.every((frame) => frame.nb_samples === 1024),
      `${preset}: unexpected AAC frame sizes`,
    );

    const finalFrameStart = audioSamples - finalFrame.nb_samples;

    assert.ok(
      finalFrameStart < requestedSamples && extraSamples < finalFrame.nb_samples,
      `${preset}: extra audio extends beyond the final overlapping frame`,
    );

    console.warn(
      `${preset}: presentation duration is correct, but this decoder exposes ` +
        `${extraSamples} trailing samples. Sample-exact decoding is not verified.`,
    );
  }

  const decode = await runNativeProcess({
    executable: tools.ffmpeg.path,
    cwd: configuration.cwd,
    signal: context.signal,
    maxOutputBytes: 1_048_576,
    args: [
      "-hide_banner",
      "-v",
      "error",
      "-nostdin",
      "-xerror",
      "-protocol_whitelist",
      "file",
      "-i",
      outputPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-f",
      "null",
      "-",
    ],
  });

  assert.equal(decode.stderr.trim(), "");
  assert.deepEqual(inputBytes, inputSnapshot);
  assert.deepEqual(result.output.bytes, outputSnapshot);
  context.signal.throwIfAborted();

  console.log(`${preset}: public combined trim and resize preserves dimensions without upscaling.`);
  console.log(
    `${preset}: public combined output preserves fractional video timing and the declared 47040-sample audio interval.`,
  );
  console.log(`${preset}: public combined byte output remains valid after export cleanup.`);
}
