import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMavio } from "../packages/mavio/dist/node.js";
import { probeNativeFileDetails } from "../packages/mavio/dist/engines/native/probe.js";
import { validateNativeThumbnailOutput } from "../packages/mavio/dist/engines/native/thumbnail-output.js";

export async function checkNativePublicThumbnail({
  configuration,
  tools,
  context,
  inputPath,
  directory,
  ffmpeg,
}) {
  const sourceSnapshot = await readFile(inputPath);
  const retained = [];

  const client = createMavio({
    engine: "auto",
    native: {
      ffmpegPath: tools.ffmpeg.path,
      ffprobePath: tools.ffprobe.path,
    },
  });

  let failure;

  try {
    for (const [preset, format] of [
      ["jpeg-balanced-v1", "jpeg"],
      ["png-lossless-v1", "png"],
    ]) {
      for (const inputKind of ["path", "bytes"]) {
        for (const outputKind of ["path", "bytes"]) {
          const label = `${preset}-${inputKind}-${outputKind}`;
          const targetPath = join(directory, `public-${label}.${format}`);
          const inputBytes = Uint8Array.from(sourceSnapshot);

          const input =
            inputKind === "path"
              ? { kind: "path", path: inputPath }
              : { kind: "bytes", bytes: inputBytes };

          const output =
            outputKind === "path" ? { kind: "path", path: targetPath } : { kind: "bytes" };

          // A separate public operation owns each staging workspace.
          await assert.rejects(
            client
              .from(input)
              .trim({ start: 0.001, end: 0.002 })
              .thumbnail({ at: 0, format, preset, output }, { signal: context.signal }),
            (error) => {
              assert.equal(error.code, "INVALID_OPTIONS");
              assert.equal(error.details?.reason, "RANGE_TOO_SHORT");
              return true;
            },
          );

          await assert.rejects(() => access(targetPath), { code: "ENOENT" });

          const result = await client
            .from(input)
            .thumbnail({ at: 0.51, format, preset, output }, { signal: context.signal });

          assert.equal(result.output.kind, outputKind);
          assert.equal(result.metadata.streams.length, 1);
          assert.equal(result.metadata.streams[0].width, 320);
          assert.equal(result.metadata.streams[0].height, 180);

          if (outputKind === "path") {
            assert.equal(result.output.path, targetPath);
            const snapshot = await readFile(targetPath);

            await assert.rejects(
              client
                .from(input)
                .thumbnail({ at: 0.51, format, preset, output }, { signal: context.signal }),
              { code: "OUTPUT_EXISTS" },
            );

            assert.deepEqual(await readFile(targetPath), snapshot);

            // The same client must remain usable after overwrite rejection.
            const recovered = await client
              .from(input)
              .thumbnail(
                { at: 0.51, format, preset, output: { kind: "bytes" } },
                { signal: context.signal },
              );

            assert.equal(recovered.output.kind, "bytes");

            retained.push({
              label: `${label}-recovery`,
              preset,
              format,
              bytes: recovered.output.bytes,
              snapshot: Uint8Array.from(recovered.output.bytes),
            });

            retained.push({
              label,
              preset,
              format,
              path: targetPath,
              snapshot,
            });
          } else {
            retained.push({
              label,
              preset,
              format,
              bytes: result.output.bytes,
              snapshot: Uint8Array.from(result.output.bytes),
            });
          }

          assert.deepEqual(inputBytes, Uint8Array.from(sourceSnapshot));
          console.log(`${label}: public export and same-client recovery passed.`);
        }
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await client.dispose();
    } catch (cleanupError) {
      failure =
        failure === undefined
          ? cleanupError
          : new AggregateError(
              [failure, cleanupError],
              "Thumbnail verification and disposal failed.",
            );
    }
  }

  if (failure !== undefined) throw failure;

  // Verify actual returned artifacts after client disposal.
  for (const item of retained) {
    let path = item.path;

    if (path === undefined) {
      assert.deepEqual(item.bytes, item.snapshot);
      path = join(directory, `retained-${item.label}.${item.format}`);
      await writeFile(path, item.bytes, { flag: "wx" });
    } else {
      assert.deepEqual(await readFile(path), item.snapshot);
    }

    const details = await probeNativeFileDetails(configuration, tools, path, context);

    validateNativeThumbnailOutput(
      details,
      { preset: item.preset, width: 320, height: 180 },
      context.jobId,
    );

    const decodedPath = join(directory, `decoded-${item.label}.rgb`);

    await ffmpeg([
      "-protocol_whitelist",
      "file",
      "-i",
      path,
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

    assert.equal((await readFile(decodedPath)).byteLength, 320 * 180 * 3);
  }

  assert.deepEqual(await readFile(inputPath), sourceSnapshot);

  console.log("Public JPEG and PNG outputs decode after client disposal.");
  console.log("Public thumbnail overwrite protection and source preservation passed.");
}
