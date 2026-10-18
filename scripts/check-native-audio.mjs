import assert from "node:assert/strict";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { captureNativeConfiguration } from "../packages/mavio/dist/engines/native/config.js";
import { prepareNativeTools } from "../packages/mavio/dist/engines/native/prepare.js";
import { discoverNativeInventory } from "../packages/mavio/dist/engines/native/inventory.js";
import { runNativeProcess } from "../packages/mavio/dist/engines/native/process.js";
import { probeNativeFileDetails } from "../packages/mavio/dist/engines/native/probe.js";
import { validateNativeAudioSource } from "../packages/mavio/dist/engines/native/audio-source.js";
import { executeNativeAudioFile } from "../packages/mavio/dist/engines/native/audio-execution.js";
import { validateNativeAudioOutput } from "../packages/mavio/dist/engines/native/audio-output.js";
import { prepareNativeAudioFile } from "../packages/mavio/dist/engines/native/audio-file.js";
import { createNativeWorkspace } from "../packages/mavio/dist/engines/native/workspace.js";
import { prepareNativeAudioBytes } from "../packages/mavio/dist/engines/native/audio-bytes.js";
import { createMavio } from "../packages/mavio/dist/node.js";
import { checkNativeAudioSelection } from "./check-native-audio-selection.mjs";
import { buildNativeAudioTrimFilters } from "../packages/mavio/dist/engines/native/audio-trim-filters.js";
import { analyzeNativeAudioTrim } from "../packages/mavio/dist/engines/native/audio-trim-analysis.js";
import { checkNativeAudioTrim } from "./check-native-audio-trim.mjs";
import { checkNativePublicAudioTrim } from "./check-native-public-audio-trim.mjs";

async function main() {
  const args = process.argv.slice(2);

  if (args.length !== 0 && args.length !== 2) {
    throw new Error("Provide either no arguments or two absolute paths: ffmpeg then ffprobe.");
  }

  const configuration = captureNativeConfiguration(
    args.length === 0 ? {} : { ffmpegPath: args[0], ffprobePath: args[1] },
  );

  const temporaryRoot = resolve(await realpath(tmpdir()));
  const controller = new AbortController();
  const context = {
    jobId: "native-audio-check",
    signal: controller.signal,
  };

  const timer = setTimeout(() => {
    controller.abort(new Error("Native audio check exceeded 60 seconds."));
  }, 60_000);

  let directory;
  let failure;
  let failed = false;

  try {
    directory = await mkdtemp(join(temporaryRoot, "mavio-native-audio-"));

    const tools = await prepareNativeTools(configuration, context);
    const inventory = await discoverNativeInventory(configuration, tools, context);

    async function ffmpeg(command) {
      const result = await runNativeProcess({
        executable: tools.ffmpeg.path,
        cwd: configuration.cwd,
        signal: context.signal,
        maxOutputBytes: 1_048_576,
        args: ["-hide_banner", "-v", "error", "-nostdin", "-n", "-xerror", ...command],
      });

      assert.equal(result.stderr.trim(), "");
      return result;
    }

    const inputPath = join(directory, "source audio.flac");

    // A short lossless fixture with a known stereo layout.
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=1",
      "-af",
      "pan=stereo|c0=c0|c1=c0",
      "-c:a",
      "flac",
      inputPath,
    ]);

    const sourceBytes = await readFile(inputPath);
    const source = await probeNativeFileDetails(configuration, tools, inputPath, context);

    const trimSource = validateNativeAudioSource(source, "audio-pcm-v1");

    assert.equal(trimSource.sampleRate, 48000);
    assert.equal(trimSource.channels, 2);

    async function analyzeAudioInterval(startSeconds, endSeconds) {
      const filters = buildNativeAudioTrimFilters(
        { startSeconds, endSeconds },
        source.formatStartTimeSeconds,
        inventory,
      );

      return analyzeNativeAudioTrim({
        configuration,
        tools,
        inventory,
        inputPath,
        streamIndex: trimSource.audioStreamIndex,
        channels: trimSource.channels,
        filters,
        context,
      });
    }

    // Half a second at 48 kHz contains 24,000 sample frames per channel.
    const selectedAudio = await analyzeAudioInterval(0.25, 0.75);

    assert.deepEqual(selectedAudio, { audioSamples: 24000 });

    console.log("Native audio trim analysis selects 24000 samples per channel.");

    // A valid microsecond interval that contains no retained audio samples.
    await assert.rejects(analyzeAudioInterval(0.000001, 0.000002), (error) => {
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.details?.reason, "RANGE_TOO_SHORT");
      assert.equal(error.details?.streamKind, "audio");
      return true;
    });

    console.log("Native empty-audio trim analysis rejects.");

    const recoveredAudio = await analyzeAudioInterval(0.25, 0.75);

    assert.deepEqual(recoveredAudio, { audioSamples: 24000 });
    assert.deepEqual(await readFile(inputPath), sourceBytes);

    console.log("Native audio trim analysis recovers and preserves the source.");

    await checkNativeAudioTrim({
      configuration,
      tools,
      inventory,
      inputPath,
      context,
      directory,
      ffmpeg,
    });

    for (const [preset, format] of [
      ["audio-balanced-v1", "mp3"],
      ["audio-pcm-v1", "wav"],
    ]) {
      const selected = validateNativeAudioSource(source, preset);

      assert.equal(selected.sampleRate, 48000);
      assert.equal(selected.channels, 2);
      assert.equal(selected.channelLayout, "stereo");

      const outputPath = join(directory, `encoded audio.${format}`);
      const options = {
        inputPath,
        outputPath,
        source,
        inventory,
        plan: {
          input: { kind: "path", path: inputPath },
          transformations: [{ type: "compress", options: { preset } }],
          terminal: { type: "export", format, preset },
          output: { kind: "bytes" },
        },
      };

      await executeNativeAudioFile(configuration, tools, options, context);

      const output = await probeNativeFileDetails(configuration, tools, outputPath, context);

      // Print actual probe evidence before validation for easy diagnosis.
      console.log(
        JSON.stringify(
          {
            preset,
            metadata: output.metadata,
            streamDetails: output.streams,
          },
          null,
          2,
        ),
      );

      validateNativeAudioOutput(output, { preset, ...selected }, context.jobId);

      const encodedBytes = await readFile(outputPath);
      assert.equal(encodedBytes.byteLength, output.metadata.sizeBytes);

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

      console.log(`${preset}: native encoding, validation and decoding passed.`);

      await assert.rejects(executeNativeAudioFile(configuration, tools, options, context), {
        code: "OUTPUT_EXISTS",
      });

      assert.deepEqual(await readFile(outputPath), encodedBytes);
      console.log(`${preset}: intermediate overwrite protection passed.`);
    }

    for (const [preset, format] of [
      ["audio-balanced-v1", "mp3"],
      ["audio-pcm-v1", "wav"],
    ]) {
      for (const inputKind of ["path", "bytes"]) {
        const workspace = await createNativeWorkspace({}, directory);
        const stagingPath = workspace.getOutputPath();
        const workspaceDirectory = dirname(stagingPath);
        const inputBytes = Uint8Array.from(sourceBytes);
        const inputSnapshot = inputBytes.slice();
        const failures = [];

        try {
          const prepared = await prepareNativeAudioFile({
            configuration,
            tools,
            inventory,
            context,
            workspace,
            plan: {
              input:
                inputKind === "path"
                  ? { kind: "path", path: inputPath }
                  : { kind: "bytes", bytes: inputBytes },
              transformations: [
                {
                  type: "extractAudio",
                  options: {
                    streamIndex: source.metadata.streams[0].index,
                  },
                },
                { type: "compress", options: { preset } },
              ],
              terminal: { type: "export", format, preset },
              output: { kind: "bytes" },
            },
          });

          assert.equal(prepared.path, stagingPath);
          assert.equal(prepared.metadata.container, format);
          assert.equal(prepared.metadata.streams.length, 1);

          const audio = prepared.metadata.streams[0];

          assert.equal(audio.kind, "audio");
          assert.equal(audio.codec, preset === "audio-balanced-v1" ? "mp3" : "pcm_s16le");
          assert.equal(audio.sampleRate, 48000);
          assert.equal(audio.channels, 2);

          const stagedBytes = await readFile(prepared.path);

          assert.equal(stagedBytes.byteLength, prepared.metadata.sizeBytes);

          await ffmpeg([
            "-protocol_whitelist",
            "file",
            "-i",
            prepared.path,
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-f",
            "null",
            "-",
          ]);

          assert.deepEqual(inputBytes, inputSnapshot);

          console.log(`${preset}: integrated ${inputKind} input preparation and decoding passed.`);
        } catch (error) {
          failures.push(error);
        }

        // Cleanup belongs to this caller, including after preparation fails.
        try {
          await workspace.dispose();
        } catch (error) {
          failures.push(error);
        }

        if (failures.length === 1) throw failures[0];

        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            "Audio preparation check and workspace cleanup failed.",
          );
        }

        await assert.rejects(access(workspaceDirectory), {
          code: "ENOENT",
        });

        console.log(`${preset}: ${inputKind} input workspace cleanup passed.`);
      }
    }

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
            transformations: [{ type: "compress", options: { preset } }],
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
        throw new AggregateError(failures, "Audio byte preparation and cleanup failed.");
      }

      assert.ok(prepared);
      await assert.rejects(access(workspaceDirectory), {
        code: "ENOENT",
      });

      assert.deepEqual(inputBytes, inputSnapshot);
      assert.equal(prepared.bytes.byteLength, prepared.metadata.sizeBytes);

      const returnedSnapshot = prepared.bytes.slice();
      const verificationPath = join(directory, `returned bytes after cleanup.${format}`);

      // Write only after the original encoding workspace is gone.
      await writeFile(verificationPath, prepared.bytes, { flag: "wx" });

      const reprobed = await probeNativeFileDetails(
        configuration,
        tools,
        verificationPath,
        context,
      );

      const selected = validateNativeAudioSource(source, preset);

      validateNativeAudioOutput(reprobed, { preset, ...selected }, context.jobId);

      assert.deepEqual(reprobed.metadata, prepared.metadata);

      await ffmpeg([
        "-protocol_whitelist",
        "file",
        "-i",
        verificationPath,
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-f",
        "null",
        "-",
      ]);

      assert.deepEqual(prepared.bytes, returnedSnapshot);
      assert.deepEqual(inputBytes, inputSnapshot);

      console.log(`${preset}: returned audio bytes probe and decode after workspace cleanup.`);
      console.log(`${preset}: returned bytes and source bytes remain unchanged.`);
    }

    const audioClient = createMavio({
      engine: "auto",
      native: {
        ffmpegPath: tools.ffmpeg.path,
        ffprobePath: tools.ffprobe.path,
      },
    });

    const publicResults = [];
    const publicPathResults = [];
    const publicFailures = [];

    try {
      for (const [preset, format] of [
        ["audio-balanced-v1", "mp3"],
        ["audio-pcm-v1", "wav"],
      ]) {
        for (const inputKind of ["path", "bytes"]) {
          const inputBytes = Uint8Array.from(sourceBytes);
          const inputSnapshot = inputBytes.slice();

          const result = await audioClient
            .from(
              inputKind === "path"
                ? { kind: "path", path: inputPath }
                : { kind: "bytes", bytes: inputBytes },
            )
            .extractAudio({
              streamIndex: source.metadata.streams[0].index,
            })
            .compress({ preset })
            .export(
              {
                format,
                output: { kind: "bytes" },
              },
              { signal: context.signal },
            );

          assert.equal(result.output.kind, "bytes");
          assert.equal(result.warnings?.length ?? 0, 0);
          assert.ok(result.output.bytes.byteLength > 0);
          assert.equal(result.output.bytes.byteLength, result.metadata.sizeBytes);
          assert.deepEqual(inputBytes, inputSnapshot);

          publicResults.push({
            preset,
            format,
            inputKind,
            result,
            snapshot: result.output.bytes.slice(),
            inputBytes,
            inputSnapshot,
          });

          console.log(`${preset}: public ${inputKind}-to-bytes export passed.`);

          const targetPath = join(directory, `public ${inputKind} to path.${format}`);

          const pathPipeline = audioClient
            .from(
              inputKind === "path"
                ? { kind: "path", path: inputPath }
                : { kind: "bytes", bytes: inputBytes },
            )
            .extractAudio({
              streamIndex: source.metadata.streams[0].index,
            })
            .compress({ preset });

          const pathResult = await pathPipeline.export(
            {
              format,
              output: { kind: "path", path: targetPath },
            },
            { signal: context.signal },
          );

          assert.deepEqual(pathResult.output, {
            kind: "path",
            path: targetPath,
          });
          assert.equal(pathResult.warnings?.length ?? 0, 0);

          const publishedBytes = await readFile(targetPath);

          assert.ok(publishedBytes.byteLength > 0);
          assert.equal(publishedBytes.byteLength, pathResult.metadata.sizeBytes);

          await assert.rejects(
            pathPipeline.export(
              {
                format,
                output: { kind: "path", path: targetPath },
              },
              { signal: context.signal },
            ),
            { code: "OUTPUT_EXISTS" },
          );

          assert.deepEqual(await readFile(targetPath), publishedBytes);
          assert.deepEqual(inputBytes, inputSnapshot);

          // Verify the same client can export again after rejection.
          const recoveryPath = join(directory, `public ${inputKind} recovery.${format}`);

          const recovery = await pathPipeline.export(
            {
              format,
              output: { kind: "path", path: recoveryPath },
            },
            { signal: context.signal },
          );

          assert.deepEqual(recovery.output, {
            kind: "path",
            path: recoveryPath,
          });
          assert.equal(recovery.warnings?.length ?? 0, 0);

          publicPathResults.push({
            preset,
            inputKind,
            targetPath,
            metadata: pathResult.metadata,
            snapshot: publishedBytes,
            recoveryPath,
            recoveryMetadata: recovery.metadata,
          });

          console.log(
            `${preset}: public ${inputKind}-to-path export, overwrite rejection and recovery passed.`,
          );
        }
      }
    } catch (error) {
      publicFailures.push(error);
    }

    if (publicFailures.length === 0) {
      try {
        const exportedWav = publicPathResults.find(
          (item) => item.preset === "audio-pcm-v1" && item.inputKind === "path",
        );

        assert.ok(exportedWav);

        const wavPath = exportedWav.targetPath;
        const wavBytes = await readFile(wavPath);

        assert.deepEqual(wavBytes, exportedWav.snapshot);

        for (const [preset, format] of [
          ["audio-balanced-v1", "mp3"],
          ["audio-pcm-v1", "wav"],
        ]) {
          for (const inputKind of ["path", "bytes"]) {
            const inputBytes = Uint8Array.from(wavBytes);
            const inputSnapshot = inputBytes.slice();

            // No extractAudio call: audio presets must select
            // the first audio stream by default.
            const result = await audioClient
              .from(
                inputKind === "path"
                  ? { kind: "path", path: wavPath }
                  : { kind: "bytes", bytes: inputBytes },
              )
              .compress({ preset })
              .export(
                {
                  format,
                  output: { kind: "bytes" },
                },
                { signal: context.signal },
              );

            assert.equal(result.output.kind, "bytes");
            assert.equal(result.warnings?.length ?? 0, 0);
            assert.equal(result.output.bytes.byteLength, result.metadata.sizeBytes);
            assert.equal(result.metadata.streams.length, 1);

            const audio = result.metadata.streams[0];

            assert.equal(audio.kind, "audio");
            assert.equal(audio.codec, preset === "audio-balanced-v1" ? "mp3" : "pcm_s16le");
            assert.equal(audio.sampleRate, 48000);
            assert.equal(audio.channels, 2);
            assert.deepEqual(inputBytes, inputSnapshot);

            // Reuse the existing post-disposal probe/decode checks.
            publicResults.push({
              preset,
              format,
              inputKind: `wav-reinput-${inputKind}`,
              result,
              snapshot: result.output.bytes.slice(),
              inputBytes,
              inputSnapshot,
            });

            console.log(
              `${preset}: public WAV ${inputKind} re-input with default audio selection passed.`,
            );
          }
        }

        assert.deepEqual(await readFile(wavPath), wavBytes);
        console.log("Public WAV re-input source remains unchanged.");

        await checkNativeAudioSelection({
          client: audioClient,
          configuration,
          tools,
          context,
          directory,
          ffmpeg,
        });

        await checkNativePublicAudioTrim({
          client: audioClient,
          configuration,
          tools,
          inputPath,
          context,
          directory,
          ffmpeg,
        });
      } catch (error) {
        publicFailures.push(error);
      }
    }

    try {
      await audioClient.dispose();
    } catch (error) {
      publicFailures.push(error);
    }

    if (publicFailures.length === 1) throw publicFailures[0];

    if (publicFailures.length > 1) {
      throw new AggregateError(publicFailures, "Public audio export and client disposal failed.");
    }

    // All checks below run after the exporting client has been disposed.
    for (const item of publicResults) {
      const verificationPath = join(
        directory,
        `public ${item.inputKind} bytes after disposal.${item.format}`,
      );

      assert.deepEqual(item.result.output.bytes, item.snapshot);

      await writeFile(verificationPath, item.result.output.bytes, {
        flag: "wx",
      });

      const reprobed = await probeNativeFileDetails(
        configuration,
        tools,
        verificationPath,
        context,
      );

      const selected = validateNativeAudioSource(source, item.preset);

      validateNativeAudioOutput(reprobed, { preset: item.preset, ...selected }, context.jobId);

      assert.deepEqual(reprobed.metadata, item.result.metadata);

      await ffmpeg([
        "-protocol_whitelist",
        "file",
        "-i",
        verificationPath,
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-f",
        "null",
        "-",
      ]);

      assert.deepEqual(item.result.output.bytes, item.snapshot);
      assert.deepEqual(item.inputBytes, item.inputSnapshot);

      console.log(
        `${item.preset}: public ${item.inputKind}-to-bytes output probes and decodes after client disposal.`,
      );
    }

    for (const item of publicPathResults) {
      assert.deepEqual(await readFile(item.targetPath), item.snapshot);

      for (const [path, metadata] of [
        [item.targetPath, item.metadata],
        [item.recoveryPath, item.recoveryMetadata],
      ]) {
        const reprobed = await probeNativeFileDetails(configuration, tools, path, context);

        const selected = validateNativeAudioSource(source, item.preset);

        validateNativeAudioOutput(reprobed, { preset: item.preset, ...selected }, context.jobId);

        assert.deepEqual(reprobed.metadata, metadata);
        assert.equal((await readFile(path)).byteLength, metadata.sizeBytes);

        await ffmpeg([
          "-protocol_whitelist",
          "file",
          "-i",
          path,
          "-map",
          "0:a:0",
          "-vn",
          "-sn",
          "-dn",
          "-f",
          "null",
          "-",
        ]);
      }

      console.log(
        `${item.preset}: public ${item.inputKind}-to-path outputs survive client disposal and decode.`,
      );
    }

    assert.deepEqual(await readFile(inputPath), sourceBytes);
    console.log("Native audio source remains unchanged.");
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    clearTimeout(timer);

    if (directory !== undefined) {
      try {
        assert.equal(dirname(directory), temporaryRoot);
        assert.ok(basename(directory).startsWith("mavio-native-audio-"));

        await rm(directory, { recursive: true, force: true });
        console.log("Native audio temporary files removed.");
      } catch (cleanupError) {
        failure = failed
          ? new AggregateError(
              [failure, cleanupError],
              "Native audio check and cleanup both failed.",
            )
          : cleanupError;
        failed = true;
      }
    }
  }

  if (failed) throw failure;
}

try {
  await main();
} catch (error) {
  console.error("Native audio check failed.");
  console.error(error);
  process.exitCode = 1;
}
