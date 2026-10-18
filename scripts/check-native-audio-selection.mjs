import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { probeNativeFileDetails } from "../packages/mavio/dist/engines/native/probe.js";
import { validateNativeAudioOutput } from "../packages/mavio/dist/engines/native/audio-output.js";

export async function checkNativeAudioSelection({
  client,
  configuration,
  tools,
  context,
  directory,
  ffmpeg,
}) {
  const sourcePath = join(directory, "multiple audio tracks.mkv");

  // Absolute indexes:
  // 0 = video, 1 = 48 kHz mono audio, 2 = 44.1 kHz mono audio.
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=32x32:r=10:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=44100:duration=1",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-map",
    "2:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-c:a",
    "flac",
    sourcePath,
  ]);

  const originalBytes = await readFile(sourcePath);

  const source = await probeNativeFileDetails(configuration, tools, sourcePath, context);

  assert.deepEqual(
    source.metadata.streams.map((stream) => ({
      index: stream.index,
      kind: stream.kind,
    })),
    [
      { index: 0, kind: "video" },
      { index: 1, kind: "audio" },
      { index: 2, kind: "audio" },
    ],
  );

  assert.equal(source.metadata.streams[1].sampleRate, 48000);
  assert.equal(source.metadata.streams[2].sampleRate, 44100);

  for (const [preset, format] of [
    ["audio-balanced-v1", "mp3"],
    ["audio-pcm-v1", "wav"],
  ]) {
    for (const selection of [
      { name: "default", streamIndex: undefined, sampleRate: 48000 },
      { name: "explicit-second", streamIndex: 2, sampleRate: 44100 },
    ]) {
      let pipeline = client.from({ kind: "path", path: sourcePath });

      if (selection.streamIndex !== undefined) {
        pipeline = pipeline.extractAudio({
          streamIndex: selection.streamIndex,
        });
      }

      const result = await pipeline.compress({ preset }).export(
        {
          format,
          output: { kind: "bytes" },
        },
        { signal: context.signal },
      );

      assert.equal(result.output.kind, "bytes");
      assert.equal(result.warnings?.length ?? 0, 0);
      assert.equal(result.metadata.streams.length, 1);

      const audio = result.metadata.streams[0];

      assert.equal(audio.kind, "audio");
      assert.equal(audio.sampleRate, selection.sampleRate);
      assert.equal(audio.channels, 1);
      assert.equal(audio.codec, preset === "audio-balanced-v1" ? "mp3" : "pcm_s16le");
      assert.equal(result.output.bytes.byteLength, result.metadata.sizeBytes);

      const outputPath = join(directory, `selected ${selection.name}.${format}`);

      await writeFile(outputPath, result.output.bytes, { flag: "wx" });

      const output = await probeNativeFileDetails(configuration, tools, outputPath, context);

      validateNativeAudioOutput(
        output,
        {
          preset,
          sampleRate: selection.sampleRate,
          channels: 1,
          channelLayout: "mono",
        },
        context.jobId,
      );

      assert.deepEqual(output.metadata, result.metadata);

      await ffmpeg([
        "-protocol_whitelist",
        "file",
        "-i",
        outputPath,
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-f",
        "null",
        "-",
      ]);

      console.log(
        `${preset}: ${selection.name} audio selection preserves ${selection.sampleRate} Hz mono and decodes.`,
      );
    }
  }

  const videoOnlyPath = join(directory, "audio rejection video only.mkv");

  await ffmpeg([
    "-protocol_whitelist",
    "file",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-c:v",
    "copy",
    "-an",
    videoOnlyPath,
  ]);

  const videoOnlyBytes = await readFile(videoOnlyPath);

  for (const [preset, format] of [
    ["audio-balanced-v1", "mp3"],
    ["audio-pcm-v1", "wav"],
  ]) {
    const cases = [
      {
        name: "video-index",
        sourcePath,
        extract: { streamIndex: 0 },
        code: "INVALID_OPTIONS",
        reason: "INVALID_STREAM_INDEX",
      },
      {
        name: "absent-index",
        sourcePath,
        extract: { streamIndex: 99 },
        code: "INVALID_OPTIONS",
        reason: "INVALID_STREAM_INDEX",
      },
      {
        name: "missing-audio-default",
        sourcePath: videoOnlyPath,
        extract: undefined,
        code: "INVALID_MEDIA",
        reason: "MISSING_AUDIO",
      },
      {
        name: "missing-audio-extraction",
        sourcePath: videoOnlyPath,
        extract: {},
        code: "INVALID_MEDIA",
        reason: "MISSING_AUDIO",
      },
    ];

    for (const entry of cases) {
      const targetPath = join(directory, `rejected ${entry.name}.${format}`);

      let pipeline = client.from({
        kind: "path",
        path: entry.sourcePath,
      });

      if (entry.extract !== undefined) {
        pipeline = pipeline.extractAudio(entry.extract);
      }

      await assert.rejects(
        pipeline.compress({ preset }).export(
          {
            format,
            output: { kind: "path", path: targetPath },
          },
          { signal: context.signal },
        ),
        (error) => {
          assert.equal(error.code, entry.code);
          assert.equal(error.details?.reason, entry.reason);
          return true;
        },
      );

      await assert.rejects(access(targetPath), { code: "ENOENT" });

      // Reuse the rejected target with a valid request on the same client.
      const recovered = await client
        .from({ kind: "path", path: sourcePath })
        .extractAudio({ streamIndex: 2 })
        .compress({ preset })
        .export(
          {
            format,
            output: { kind: "path", path: targetPath },
          },
          { signal: context.signal },
        );

      assert.deepEqual(recovered.output, {
        kind: "path",
        path: targetPath,
      });
      assert.equal(recovered.warnings?.length ?? 0, 0);

      const output = await probeNativeFileDetails(configuration, tools, targetPath, context);

      validateNativeAudioOutput(
        output,
        {
          preset,
          sampleRate: 44100,
          channels: 1,
          channelLayout: "mono",
        },
        context.jobId,
      );

      assert.deepEqual(output.metadata, recovered.metadata);

      await ffmpeg([
        "-protocol_whitelist",
        "file",
        "-i",
        targetPath,
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-f",
        "null",
        "-",
      ]);

      console.log(`${preset}: ${entry.name} rejects without output; same-client recovery decodes.`);
    }
  }

  assert.deepEqual(await readFile(videoOnlyPath), videoOnlyBytes);

  assert.deepEqual(await readFile(sourcePath), originalBytes);
  console.log("Multi-track audio source remains unchanged.");
}
