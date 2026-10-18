import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prepareNativeMp4Bytes } from "../packages/mavio/dist/engines/native/mp4-bytes.js";
import { runNativeProcess } from "../packages/mavio/dist/engines/native/process.js";
import { join } from "node:path";

// Uses the existing 320×180, 24 fps, two-second audio/video fixture.
export async function checkNativeSmallPreset({
  configuration,
  tools,
  inventory,
  mediaPath,
  workspace,
  context,
  client,
  directory,
}) {
  const inputBytes = new Uint8Array(await readFile(mediaPath));
  const inputSnapshot = inputBytes.slice();

  const prepared = await prepareNativeMp4Bytes({
    configuration,
    tools,
    inventory,
    workspace,
    context,
    plan: {
      input: {
        kind: "bytes",
        bytes: inputBytes,
        name: "small preset source.mp4",
      },
      transformations: [{ type: "compress", options: { preset: "video-small-v1" } }],
      terminal: {
        type: "export",
        format: "mp4",
        preset: "video-small-v1",
      },
      output: { kind: "bytes" },
    },
  });

  assert.deepEqual(inputBytes, inputSnapshot);
  assert.ok(prepared.bytes.byteLength > 0);
  assert.equal(prepared.metadata.sizeBytes, prepared.bytes.byteLength);
  assert.equal(prepared.metadata.streams.length, 2);

  const video = prepared.metadata.streams.find((stream) => stream.kind === "video");
  const audio = prepared.metadata.streams.find((stream) => stream.kind === "audio");

  assert.ok(video);
  assert.ok(audio);
  assert.equal(video.codec, "h264");
  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  assert.equal(audio.codec, "aac");
  assert.equal(audio.sampleRate, 48000);
  assert.equal(audio.channels, 1);

  const outputPath = join(directory, "public small preset.mp4");

  const pipeline = client
    .from({ kind: "path", path: mediaPath })
    .compress({ preset: "video-small-v1" });

  const publicResult = await pipeline.export(
    {
      format: "mp4",
      output: { kind: "path", path: outputPath },
    },
    { signal: context.signal },
  );

  assert.equal(publicResult.output.kind, "path");
  assert.equal(publicResult.output.path, outputPath);
  assert.equal(publicResult.warnings?.length ?? 0, 0);

  const publishedBytes = await readFile(outputPath);
  assert.ok(publishedBytes.byteLength > 0);
  assert.equal(publicResult.metadata.sizeBytes, publishedBytes.byteLength);

  const publishedMetadata = await client
    .from({ kind: "path", path: outputPath })
    .metadata({ signal: context.signal });

  assert.deepEqual(publishedMetadata, publicResult.metadata);

  const publishedVideo = publishedMetadata.streams.find((stream) => stream.kind === "video");
  const publishedAudio = publishedMetadata.streams.find((stream) => stream.kind === "audio");

  assert.equal(publishedMetadata.streams.length, 2);
  assert.ok(publishedVideo);
  assert.ok(publishedAudio);
  assert.equal(publishedVideo.codec, "h264");
  assert.equal(publishedVideo.width, 320);
  assert.equal(publishedVideo.height, 180);
  assert.equal(publishedAudio.codec, "aac");
  assert.equal(publishedAudio.sampleRate, 48000);
  assert.equal(publishedAudio.channels, 1);

  await assert.rejects(
    pipeline.export(
      {
        format: "mp4",
        output: { kind: "path", path: outputPath },
      },
      { signal: context.signal },
    ),
    { code: "OUTPUT_EXISTS" },
  );

  assert.deepEqual(await readFile(outputPath), publishedBytes);

  console.log("Public small-preset path export and overwrite protection passed.");

  const frameProbe = await runNativeProcess({
    executable: tools.ffprobe.path,
    cwd: configuration.cwd,
    signal: context.signal,
    maxOutputBytes: 1_048_576,
    args: [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-select_streams",
      "v:0",
      "-show_frames",
      "-show_entries",
      "frame=width,height,best_effort_timestamp_time",
      "-of",
      "json",
      "-i",
      outputPath,
    ],
  });

  assert.equal(frameProbe.stderr.trim(), "");

  const frames = JSON.parse(frameProbe.stdout).frames;
  assert.ok(Array.isArray(frames));
  assert.equal(frames.length, 48);

  for (const [index, frame] of frames.entries()) {
    assert.equal(frame.width, 320);
    assert.equal(frame.height, 180);
    assert.equal(typeof frame.best_effort_timestamp_time, "string");
    assert.notEqual(frame.best_effort_timestamp_time.trim(), "");

    const actual = Number(frame.best_effort_timestamp_time);

    assert.ok(Number.isFinite(actual));
    assert.ok(
      Math.abs(actual - index / 24) <= 0.000002,
      `Small-preset frame ${index} has an unexpected timestamp`,
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
  context.signal.throwIfAborted();

  console.log("Native small preset preserves dimensions and video timestamps.");
  console.log("Native small-preset audio/video decoding passed.");

  return prepared;
}
