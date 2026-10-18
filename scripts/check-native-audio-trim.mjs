import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prepareNativeAudioBytes } from "../packages/mavio/dist/engines/native/audio-bytes.js";
import { createNativeWorkspace } from "../packages/mavio/dist/engines/native/workspace.js";
import { probeNativeFileDetails } from "../packages/mavio/dist/engines/native/probe.js";
import { validateNativeAudioOutput } from "../packages/mavio/dist/engines/native/audio-output.js";

export async function checkNativeAudioTrim({
  configuration,
  tools,
  inventory,
  inputPath,
  context,
  directory,
  ffmpeg,
}) {
  const sourceBytes = await readFile(inputPath);
  const referencePath = join(directory, "audio trim reference.s16le");

  // Decode the full source independently, without applying a trim filter.
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
  const sampleRate = 48000;
  const channels = 2;
  const bytesPerFrame = channels * 2;

  assert.equal(reference.byteLength, sampleRate * bytesPerFrame);

  const startSample = 12000;
  const endSample = 36000;
  const expectedSamples = endSample - startSample;
  const expectedPcm = reference.subarray(startSample * bytesPerFrame, endSample * bytesPerFrame);

  for (const [preset, format] of [
    ["audio-balanced-v1", "mp3"],
    ["audio-pcm-v1", "wav"],
  ]) {
    const workspace = await createNativeWorkspace({}, directory);
    const workspaceDirectory = dirname(workspace.getOutputPath());
    const inputBytes = Uint8Array.from(sourceBytes);
    const inputSnapshot = inputBytes.slice();
    const failures = [];
    let prepared;

    try {
      prepared = await prepareNativeAudioBytes({
        configuration,
        tools,
        inventory,
        context,
        workspace,
        plan: {
          input: { kind: "bytes", bytes: inputBytes },
          transformations: [
            { type: "trim", options: { start: 0.25, end: 0.75 } },
            { type: "compress", options: { preset } },
          ],
          terminal: { type: "export", format, preset },
          output: { kind: "bytes" },
        },
      });
    } catch (error) {
      failures.push(error);
    }

    try {
      await workspace.dispose();
    } catch (error) {
      failures.push(error);
    }

    if (failures.length === 1) throw failures[0];

    if (failures.length > 1) {
      throw new AggregateError(failures, "Trimmed audio preparation and cleanup failed.");
    }

    assert.ok(prepared);
    await assert.rejects(access(workspaceDirectory), { code: "ENOENT" });
    assert.deepEqual(inputBytes, inputSnapshot);

    const outputSnapshot = prepared.bytes.slice();
    const outputPath = join(directory, `integrated trimmed audio.${format}`);

    await writeFile(outputPath, prepared.bytes, { flag: "wx" });

    const output = await probeNativeFileDetails(configuration, tools, outputPath, context);

    validateNativeAudioOutput(
      output,
      {
        preset,
        sampleRate,
        channels,
        channelLayout: "stereo",
      },
      context.jobId,
    );

    assert.deepEqual(output.metadata, prepared.metadata);

    const decodedPath = join(directory, `decoded trimmed ${format}.s16le`);

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
      "-c:a",
      "pcm_s16le",
      "-f",
      "s16le",
      decodedPath,
    ]);

    const decoded = await readFile(decodedPath);

    assert.equal(decoded.byteLength % bytesPerFrame, 0);
    assert.equal(decoded.byteLength / bytesPerFrame, expectedSamples);

    console.log(`${preset}: integrated trim decodes to 24000 samples per channel.`);

    if (preset === "audio-pcm-v1") {
      assert.deepEqual(decoded, expectedPcm);
      console.log("Trimmed PCM WAV exactly matches the requested source samples.");
    }

    assert.deepEqual(prepared.bytes, outputSnapshot);
    assert.deepEqual(inputBytes, inputSnapshot);

    console.log(`${preset}: trimmed bytes remain valid after workspace cleanup.`);
  }

  assert.deepEqual(await readFile(inputPath), sourceBytes);
}
