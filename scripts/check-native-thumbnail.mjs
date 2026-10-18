import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { captureNativeConfiguration } from "../packages/mavio/dist/engines/native/config.js";
import { prepareNativeTools } from "../packages/mavio/dist/engines/native/prepare.js";
import { discoverNativeInventory } from "../packages/mavio/dist/engines/native/inventory.js";
import { runNativeProcess } from "../packages/mavio/dist/engines/native/process.js";
import { probeNativeFileDetails } from "../packages/mavio/dist/engines/native/probe.js";
import { executeNativeThumbnailFile } from "../packages/mavio/dist/engines/native/thumbnail-execution.js";
import { validateNativeThumbnailOutput } from "../packages/mavio/dist/engines/native/thumbnail-output.js";
import { access, writeFile } from "node:fs/promises";
import { createNativeWorkspace } from "../packages/mavio/dist/engines/native/workspace.js";
import { prepareNativeThumbnailFile } from "../packages/mavio/dist/engines/native/thumbnail-file.js";
import { prepareNativeThumbnailBytes } from "../packages/mavio/dist/engines/native/thumbnail-bytes.js";
import { checkNativePublicThumbnail } from "./check-native-public-thumbnail.mjs";
import { checkNativeThumbnailResize } from "./check-native-thumbnail-resize.mjs";

async function main() {
  const args = process.argv.slice(2);

  if (args.length !== 0 && args.length !== 2) {
    throw new Error("Provide no arguments or absolute FFmpeg and FFprobe paths.");
  }

  const configuration = captureNativeConfiguration(
    args.length === 0 ? {} : { ffmpegPath: args[0], ffprobePath: args[1] },
  );

  const temporaryRoot = resolve(await realpath(tmpdir()));
  const controller = new AbortController();
  const context = {
    jobId: "native-thumbnail-check",
    signal: controller.signal,
  };

  const timer = setTimeout(() => {
    controller.abort(new Error("Native thumbnail check exceeded 60 seconds."));
  }, 60_000);

  let directory;
  let failure;

  try {
    directory = await mkdtemp(join(temporaryRoot, "mavio-native-thumbnail-"));

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
    }

    const inputPath = join(directory, "source video.mp4");

    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24:duration=2",
      "-vf",
      "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-color_range",
      "tv",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      inputPath,
    ]);

    const sourceBytes = await readFile(inputPath);
    const source = await probeNativeFileDetails(configuration, tools, inputPath, context);

    const cases = [
      { preset: "jpeg-balanced-v1", format: "jpeg", extension: "jpg" },
      { preset: "png-lossless-v1", format: "png", extension: "png" },
    ];

    for (const { preset, format, extension } of cases) {
      const outputPath = join(directory, `${preset}.${extension}`);
      const decodedPath = join(directory, `${preset}.rgb`);

      const plan = {
        input: { kind: "path", path: inputPath },
        transformations: [],
        terminal: { type: "thumbnail", at: 0.51, format, preset },
        output: { kind: "path", path: outputPath },
      };

      const options = {
        plan,
        source,
        inventory,
        inputPath,
        outputPath,
      };

      await executeNativeThumbnailFile(configuration, tools, options, context);

      const output = await probeNativeFileDetails(configuration, tools, outputPath, context);

      validateNativeThumbnailOutput(output, { preset, width: 320, height: 180 }, context.jobId);

      const encoded = await readFile(outputPath);
      assert.equal(encoded.byteLength, output.metadata.sizeBytes);

      if (format === "jpeg") {
        assert.deepEqual(Array.from(encoded.subarray(0, 3)), [255, 216, 255]);
        assert.deepEqual(Array.from(encoded.subarray(-2)), [255, 217]);
      } else {
        assert.deepEqual(Array.from(encoded.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
      }

      // Decode the entire output without limiting the number of frames.
      await ffmpeg([
        "-protocol_whitelist",
        "file",
        "-i",
        outputPath,
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-pix_fmt",
        "rgb24",
        "-c:v",
        "rawvideo",
        "-fps_mode:v",
        "passthrough",
        "-f",
        "rawvideo",
        decodedPath,
      ]);

      const decoded = await readFile(decodedPath);
      assert.equal(decoded.byteLength, 320 * 180 * 3);

      console.log(`${preset}: real encoding, signature and single-frame decoding passed.`);

      await assert.rejects(
        () => executeNativeThumbnailFile(configuration, tools, options, context),
        { code: "OUTPUT_EXISTS" },
      );

      assert.deepEqual(await readFile(outputPath), encoded);
      console.log(`${preset}: intermediate overwrite protection passed.`);

      for (const inputKind of ["path", "bytes"]) {
        let workspace = await createNativeWorkspace();
        let stagedPath;
        let returnedBytes;
        let preparationFailure;

        try {
          const input =
            inputKind === "path"
              ? { kind: "path", path: inputPath }
              : { kind: "bytes", bytes: Uint8Array.from(sourceBytes) };

          const options = {
            configuration,
            tools,
            inventory,
            workspace,
            context,
            plan: {
              input,
              transformations: [],
              terminal: { type: "thumbnail", at: 0.51, format, preset },
              output: { kind: "bytes" },
            },
          };

          // At 24 fps, this retained interval contains no source frame.
          await assert.rejects(
            () =>
              prepareNativeThumbnailFile({
                ...options,
                plan: {
                  ...options.plan,
                  transformations: [{ type: "trim", options: { start: 0.001, end: 0.002 } }],
                  terminal: { type: "thumbnail", at: 0, format, preset },
                },
              }),
            (error) => {
              assert.equal(error.code, "INVALID_OPTIONS");
              assert.equal(error.details?.reason, "RANGE_TOO_SHORT");
              return true;
            },
          );

          await assert.rejects(() => access(workspace.getOutputPath()), {
            code: "ENOENT",
          });

          // Each operation owns a fresh workspace, including after rejection.
          await workspace.dispose();
          workspace = await createNativeWorkspace();

          const prepared = await prepareNativeThumbnailBytes({
            ...options,
            workspace,
          });

          returnedBytes = Uint8Array.from(prepared.bytes);
          stagedPath = workspace.getOutputPath();

          assert.equal(prepared.bytes.byteLength, prepared.metadata.sizeBytes);

          // Verify returned storage does not alias a later workspace read.
          const workspaceBytes = await workspace.readOutput(context);
          workspaceBytes.fill(0);
          assert.deepEqual(prepared.bytes, returnedBytes);
        } catch (error) {
          preparationFailure = error;
        } finally {
          try {
            await workspace.dispose();
          } catch (cleanupError) {
            preparationFailure =
              preparationFailure === undefined
                ? cleanupError
                : new AggregateError(
                    [preparationFailure, cleanupError],
                    "Thumbnail preparation and cleanup failed.",
                  );
          }
        }

        if (preparationFailure !== undefined) throw preparationFailure;

        assert.ok(returnedBytes instanceof Uint8Array);
        assert.equal(typeof stagedPath, "string");
        await assert.rejects(() => access(stagedPath), { code: "ENOENT" });

        const savedPath = join(directory, `${preset}-${inputKind}-prepared.${extension}`);
        const rawPath = join(directory, `${preset}-${inputKind}-prepared.rgb`);

        await writeFile(savedPath, returnedBytes, { flag: "wx" });

        const saved = await probeNativeFileDetails(configuration, tools, savedPath, context);
        validateNativeThumbnailOutput(saved, { preset, width: 320, height: 180 }, context.jobId);

        await ffmpeg([
          "-protocol_whitelist",
          "file",
          "-i",
          savedPath,
          "-map",
          "0:v:0",
          "-an",
          "-sn",
          "-dn",
          "-pix_fmt",
          "rgb24",
          "-c:v",
          "rawvideo",
          "-fps_mode:v",
          "passthrough",
          "-f",
          "rawvideo",
          rawPath,
        ]);

        assert.equal((await readFile(rawPath)).byteLength, 320 * 180 * 3);

        console.log(`${preset}: ${inputKind} preparation rejects empty selection and recovers.`);
        console.log(`${preset}: ${inputKind} thumbnail bytes decode after workspace cleanup.`);
      }
    }

    assert.deepEqual(await readFile(inputPath), sourceBytes);
    console.log("Native thumbnail source remains unchanged.");

    await checkNativePublicThumbnail({
      configuration,
      tools,
      context,
      inputPath,
      directory,
      ffmpeg,
    });

    await checkNativeThumbnailResize({
      configuration,
      tools,
      context,
      inputPath,
      directory,
      ffmpeg,
    });
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);

    if (directory !== undefined) {
      try {
        const target = resolve(directory);

        assert.equal(dirname(target), temporaryRoot);
        assert.ok(basename(target).startsWith("mavio-native-thumbnail-"));

        await rm(target, { recursive: true, force: true });
        console.log("Native thumbnail temporary files removed.");
      } catch (cleanupError) {
        failure =
          failure === undefined
            ? cleanupError
            : new AggregateError([failure, cleanupError], "Verification and cleanup failed.");
      }
    }
  }

  if (failure !== undefined) throw failure;
}

try {
  await main();
} catch (error) {
  console.error("Native thumbnail check failed.");
  console.error(error);
  process.exitCode = 1;
}
