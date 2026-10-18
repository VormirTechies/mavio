import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { probeNativeFileDetails } from "../packages/mavio/dist/engines/native/probe.js";
import { validateNativeAudioOutput } from "../packages/mavio/dist/engines/native/audio-output.js";

export async function checkNativePublicAudioTrim({
  client,
  configuration,
  tools,
  inputPath,
  context,
  directory,
  ffmpeg,
}) {
  const sourceBytes = await readFile(inputPath);
  const referencePath = join(directory, "public trim reference.s16le");

  await ffmpeg([
    "-protocol_whitelist",
    "file",
    "-i",
    inputPath,
    "-map",
    "0:a:0",
    "-vn",
    "-sn",
    "-dn",
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    referencePath,
  ]);

  const reference = await readFile(referencePath);
  const bytesPerFrame = 4; // Stereo, signed 16-bit PCM.
  assert.equal(reference.byteLength, 48000 * bytesPerFrame);

  const expectedPcm = reference.subarray(12000 * bytesPerFrame, 36000 * bytesPerFrame);

  for (const [preset, format] of [
    ["audio-balanced-v1", "mp3"],
    ["audio-pcm-v1", "wav"],
  ]) {
    for (const outputKind of ["bytes", "path"]) {
      const inputBytes = Uint8Array.from(sourceBytes);
      const inputSnapshot = inputBytes.slice();
      const targetPath = join(directory, `public trimmed ${outputKind}.${format}`);
      const target = outputKind === "path" ? { kind: "path", path: targetPath } : { kind: "bytes" };

      await assert.rejects(
        client
          .from({ kind: "bytes", bytes: inputBytes })
          .trim({ start: 0.000001, end: 0.000002 })
          .compress({ preset })
          .export({ format, output: target }, { signal: context.signal }),
        (error) => {
          assert.equal(error.code, "INVALID_OPTIONS");
          assert.equal(error.details?.reason, "RANGE_TOO_SHORT");
          assert.equal(error.details?.streamKind, "audio");
          return true;
        },
      );

      await assert.rejects(access(targetPath), { code: "ENOENT" });

      // Relative consecutive trims resolve to source interval [0.25, 0.75).
      const pipeline = client
        .from({ kind: "bytes", bytes: inputBytes })
        .trim({ start: 0.125, end: 0.875 })
        .extractAudio()
        .trim({ start: 0.125, end: 0.625 })
        .compress({ preset });

      const result = await pipeline.export({ format, output: target }, { signal: context.signal });

      assert.equal(result.output.kind, outputKind);
      assert.equal(result.warnings?.length ?? 0, 0);

      let encodedBytes;

      if (result.output.kind === "bytes") {
        encodedBytes = Uint8Array.from(result.output.bytes);
        await writeFile(targetPath, result.output.bytes, { flag: "wx" });
      } else {
        assert.equal(result.output.path, targetPath);
        encodedBytes = await readFile(targetPath);

        await assert.rejects(
          pipeline.export({ format, output: target }, { signal: context.signal }),
          { code: "OUTPUT_EXISTS" },
        );

        assert.deepEqual(await readFile(targetPath), encodedBytes);
      }

      assert.equal(encodedBytes.byteLength, result.metadata.sizeBytes);

      const output = await probeNativeFileDetails(configuration, tools, targetPath, context);

      validateNativeAudioOutput(
        output,
        {
          preset,
          sampleRate: 48000,
          channels: 2,
          channelLayout: "stereo",
        },
        context.jobId,
      );

      assert.deepEqual(output.metadata, result.metadata);

      const decodedPath = join(directory, `public trimmed ${outputKind} ${format}.s16le`);

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
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        decodedPath,
      ]);

      const decoded = await readFile(decodedPath);
      assert.equal(decoded.byteLength, 24000 * bytesPerFrame);

      if (preset === "audio-pcm-v1") {
        assert.deepEqual(decoded, expectedPcm);
      }

      if (result.output.kind === "bytes") {
        assert.deepEqual(result.output.bytes, encodedBytes);
      }

      assert.deepEqual(inputBytes, inputSnapshot);

      console.log(
        `${preset}: public trimmed ${outputKind} output decodes to 24000 samples per channel.`,
      );
      console.log(`${preset}: empty trim rejection and ${outputKind} recovery passed.`);

      if (outputKind === "path") {
        console.log(`${preset}: public trimmed path overwrite protection passed.`);
      }

      if (preset === "audio-pcm-v1") {
        console.log(
          `Public trimmed WAV ${outputKind} output matches the requested source samples.`,
        );
      }
    }
  }

  assert.deepEqual(await readFile(inputPath), sourceBytes);
}
