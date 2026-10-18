import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMavio } from "../packages/mavio/dist/node.js";
import { probeNativeFileDetails } from "../packages/mavio/dist/engines/native/probe.js";
import { validateNativeThumbnailOutput } from "../packages/mavio/dist/engines/native/thumbnail-output.js";

export async function checkNativeThumbnailResize({
  configuration,
  tools,
  context,
  inputPath,
  directory,
  ffmpeg,
}) {
  const snapshot = await readFile(inputPath);
  const outputs = [];

  const client = createMavio({
    engine: "auto",
    native: {
      ffmpegPath: tools.ffmpeg.path,
      ffprobePath: tools.ffprobe.path,
    },
  });

  let failure;

  try {
    for (const [preset, format, width, height] of [
      ["jpeg-balanced-v1", "jpeg", 158, 88],
      ["png-lossless-v1", "png", 159, 89],
    ]) {
      const result = await client
        .from({ kind: "bytes", bytes: Uint8Array.from(snapshot) })
        .trim({ start: 0.125, end: 1.875 })
        .resize({ width: 159, height: 99 })
        .trim({ start: 0.125, end: 1.625 })
        .resize({ width: 320, height: 180 })
        .thumbnail(
          {
            at: 0.26,
            preset,
            format,
            output: { kind: "bytes" },
          },
          { signal: context.signal },
        );

      assert.equal(result.output.kind, "bytes");
      assert.equal(result.metadata.streams[0].width, width);
      assert.equal(result.metadata.streams[0].height, height);

      outputs.push({
        preset,
        format,
        width,
        height,
        bytes: result.output.bytes,
        snapshot: Uint8Array.from(result.output.bytes),
      });
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
          : new AggregateError([failure, cleanupError], "Thumbnail check and disposal failed.");
    }
  }

  if (failure !== undefined) throw failure;

  for (const item of outputs) {
    const { preset, format, width, height } = item;
    const actualPath = join(directory, `resize-actual-${preset}.${format}`);
    const referencePath = join(directory, `resize-reference-${preset}.${format}`);

    assert.deepEqual(item.bytes, item.snapshot);
    await writeFile(actualPath, item.bytes, { flag: "wx" });

    const details = await probeNativeFileDetails(configuration, tools, actualPath, context);

    validateNativeThumbnailOutput(details, { preset, width, height }, context.jobId);

    const jpeg = format === "jpeg";
    const conversion = jpeg
      ? "scale=in_color_matrix=bt709:out_color_matrix=bt601:in_range=tv:out_range=pc,format=yuvj420p"
      : "scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24";

    // The known fixture is 24 fps, beginning at timestamp zero.
    // Consecutive trims place the request at source time 0.51 seconds.
    // Frame 12 is at 0.5; the first frame at/after 0.51 is frame 13.
    // Select by frame index independently of Mavio's time filters.
    await ffmpeg([
      "-noautorotate",
      "-protocol_whitelist",
      "file",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-map_metadata",
      "-1",
      "-map_metadata:s",
      "-1",
      "-map_chapters",
      "-1",
      "-vf",
      [
        "select=eq(n\\,13)",
        "setpts=PTS-STARTPTS",
        conversion,
        `scale=w=${width}:h=${height}:flags=lanczos`,
        "setsar=1",
        `scale=w=${width}:h=${height}:flags=lanczos`,
        "setsar=1",
      ].join(","),
      "-fps_mode:v",
      "passthrough",
      "-color_range",
      "pc",
      "-colorspace",
      jpeg ? "smpte170m" : "rgb",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      ...(jpeg
        ? ["-c:v", "mjpeg", "-q:v", "3", "-pix_fmt", "yuvj420p"]
        : ["-c:v", "png", "-pix_fmt", "rgb24", "-compression_level", "6"]),
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      referencePath,
    ]);

    const decoded = [];

    for (const [label, path] of [
      ["actual", actualPath],
      ["reference", referencePath],
    ]) {
      const rawPath = join(directory, `resize-${label}-${preset}.rgb`);

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
        "-c:v",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-fps_mode:v",
        "passthrough",
        "-f",
        "rawvideo",
        rawPath,
      ]);

      const bytes = await readFile(rawPath);
      assert.equal(bytes.byteLength, width * height * 3);
      decoded.push(bytes);
    }

    assert.deepEqual(decoded[0], decoded[1]);

    console.log(`${preset}: consecutive resize preserves ${width}x${height} without upscaling.`);
    console.log(`${preset}: decoded thumbnail matches independently selected source frame 13.`);
  }

  assert.deepEqual(await readFile(inputPath), snapshot);
  console.log("Resized thumbnail bytes survive disposal; source remains unchanged.");
}
