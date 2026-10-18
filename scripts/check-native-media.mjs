import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { captureMetadata } from "../packages/mavio/dist/core/adapter-response.js";
import { captureNativeConfiguration } from "../packages/mavio/dist/engines/native/config.js";
import { prepareNativeTools } from "../packages/mavio/dist/engines/native/prepare.js";
import { runNativeProcess } from "../packages/mavio/dist/engines/native/process.js";
import { createMavio } from "../packages/mavio/dist/node.js";
import { discoverNativeInventory } from "../packages/mavio/dist/engines/native/inventory.js";
import { buildNativeMp4Command } from "../packages/mavio/dist/engines/native/mp4-command.js";
import { probeNativeFileDetails } from "../packages/mavio/dist/engines/native/probe.js";
import { executeNativeMp4File } from "../packages/mavio/dist/engines/native/mp4-execution.js";
import { validateNativeMp4Output } from "../packages/mavio/dist/engines/native/mp4-output.js";
import { createNativeWorkspace } from "../packages/mavio/dist/engines/native/workspace.js";
import { prepareNativeMp4Bytes } from "../packages/mavio/dist/engines/native/mp4-bytes.js";
import { buildNativeTrimFilters } from "../packages/mavio/dist/engines/native/trim-filters.js";
import { checkNativeTrimSelection } from "./check-native-trim-selection.mjs";
import { prepareNativeMp4File } from "../packages/mavio/dist/engines/native/mp4-file.js";
import { buildNativeResizeFilters } from "../packages/mavio/dist/engines/native/resize-filters.js";
import { validateNativeResizeSource } from "../packages/mavio/dist/engines/native/resize-source.js";
import { checkNativeTrimResize } from "./check-native-trim-resize.mjs";
import { checkNativeSmallPreset } from "./check-native-small-preset.mjs";

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
    jobId: "native-media-check",
    signal: controller.signal,
  };

  const timer = setTimeout(() => {
    controller.abort(new Error("Native media check exceeded 60 seconds."));
  }, 60_000);

  let directory;
  let primaryFailed = false;
  let cleanupFailure;
  let metadata;
  let client;
  let byteWorkspace;

  try {
    directory = await mkdtemp(join(temporaryRoot, "mavio-native-media-"));

    const tools = await prepareNativeTools(configuration, context);
    const mediaPath = join(directory, "sample with spaces.mp4");

    await runNativeProcess({
      executable: tools.ffmpeg.path,
      cwd: configuration.cwd,
      signal: controller.signal,
      maxOutputBytes: 1_048_576,
      args: [
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-n",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=24:duration=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=2",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-vf",
        "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        "-color_range",
        "tv",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        "-t",
        "2",
        mediaPath,
      ],
    });

    client = createMavio({
      engine: "auto",
      native: {
        ffmpegPath: tools.ffmpeg.path,
        ffprobePath: tools.ffprobe.path,
      },
    });

    metadata = await client
      .from({ kind: "path", path: mediaPath })
      .metadata({ signal: controller.signal });

    // Verify the real response also satisfies the public metadata contract.
    captureMetadata(metadata);

    assert.equal(metadata.streams.length, 2);

    const video = metadata.streams.find((stream) => stream.kind === "video");
    const audio = metadata.streams.find((stream) => stream.kind === "audio");

    assert.ok(video, "Expected a video stream.");
    assert.ok(audio, "Expected an audio stream.");

    assert.equal(video.codec, "h264");
    assert.equal(video.width, 320);
    assert.equal(video.height, 180);
    assert.ok(video.frameRate, "Expected an average frame rate.");
    assert.equal(video.frameRate.numerator / video.frameRate.denominator, 24);

    assert.equal(audio.codec, "aac");
    assert.equal(audio.sampleRate, 48000);
    assert.equal(audio.channels, 1);

    assert.ok(
      metadata.container?.split(",").includes("mp4"),
      "Expected an MP4 container identifier.",
    );

    assert.ok(
      metadata.durationSeconds >= 1.9 && metadata.durationSeconds <= 2.2,
      `Unexpected fixture duration: ${metadata.durationSeconds}`,
    );

    const file = await stat(mediaPath);
    assert.ok(file.size > 0);
    assert.equal(metadata.sizeBytes, file.size);
    assert.ok(metadata.bitrateBitsPerSecond > 0);

    const invalidPath = join(directory, "invalid media.mp4");
    await writeFile(invalidPath, "This file contains no multimedia data.");

    await assert.rejects(
      client.from({ kind: "path", path: invalidPath }).metadata({ signal: controller.signal }),
      {
        code: "EXECUTION_FAILED",
        details: {
          reason: "NONZERO_EXIT",
          tool: "ffprobe",
        },
      },
    );

    // A failed probe must allow the next job to reinitialize successfully.
    const recovered = await client
      .from({ kind: "path", path: mediaPath })
      .metadata({ signal: controller.signal });

    assert.deepEqual(recovered, metadata);

    const bytes = new Uint8Array(await readFile(mediaPath));

    const fromBytes = await client
      .from({
        kind: "bytes",
        bytes,
        name: "sample.mp4",
      })
      .metadata({ signal: controller.signal });

    assert.deepEqual(fromBytes, metadata);
    assert.equal(bytes.byteLength, metadata.sizeBytes);

    console.log("Public native byte metadata check passed.");

    controller.signal.throwIfAborted();
    const inventory = await discoverNativeInventory(configuration, tools, context);

    const sourceDetails = await probeNativeFileDetails(configuration, tools, mediaPath, context);

    const encodedPath = join(directory, "encoded output.mp4");

    const commandOptions = {
      plan: {
        input: { kind: "path", path: mediaPath },
        transformations: [
          {
            type: "compress",
            options: { preset: "video-balanced-v1" },
          },
        ],
        terminal: {
          type: "export",
          format: "mp4",
          preset: "video-balanced-v1",
        },
        output: { kind: "path", path: encodedPath },
      },
      source: sourceDetails,
      inventory,
      inputPath: mediaPath,
      outputPath: encodedPath,
    };

    const command = buildNativeMp4Command(commandOptions);

    const encodeOptions = {
      executable: tools.ffmpeg.path,
      cwd: configuration.cwd,
      signal: controller.signal,
      maxOutputBytes: 1_048_576,
      args: command,
    };

    await executeNativeMp4File(configuration, tools, commandOptions, context);

    // Mavio must reject this occupied path consistently.
    await assert.rejects(executeNativeMp4File(configuration, tools, commandOptions, context), {
      code: "OUTPUT_EXISTS",
    });

    const encoded = await probeNativeFileDetails(configuration, tools, encodedPath, context);

    validateNativeMp4Output(
      encoded,
      {
        width: 320,
        height: 180,
        audio: {
          sampleRate: 48000,
          channels: 1,
          channelLayout: "mono",
        },
      },
      context.jobId,
    );

    console.log("Native MP4 output validation passed.");

    captureMetadata(encoded.metadata);

    assert.equal(encoded.metadata.streams.length, 2);

    const encodedVideo = encoded.metadata.streams.find((stream) => stream.kind === "video");
    const encodedAudio = encoded.metadata.streams.find((stream) => stream.kind === "audio");

    assert.ok(encodedVideo, "Encoded video stream is missing.");
    assert.ok(encodedAudio, "Encoded audio stream is missing.");

    assert.equal(encodedVideo.codec, "h264");
    assert.equal(encodedVideo.width, 320);
    assert.equal(encodedVideo.height, 180);
    assert.ok(encodedVideo.frameRate);
    assert.equal(encodedVideo.frameRate.numerator / encodedVideo.frameRate.denominator, 24);

    assert.equal(encodedAudio.codec, "aac");
    assert.equal(encodedAudio.sampleRate, 48000);
    assert.equal(encodedAudio.channels, 1);

    assert.ok(encoded.metadata.container?.split(",").includes("mp4"));
    assert.ok(
      encoded.metadata.durationSeconds >= 1.9 && encoded.metadata.durationSeconds <= 2.2,
      `Unexpected encoded duration: ${encoded.metadata.durationSeconds}`,
    );

    const videoDetails = encoded.streams.find((stream) => stream.index === encodedVideo.index);
    const audioDetails = encoded.streams.find((stream) => stream.index === encodedAudio.index);

    assert.ok(videoDetails);
    assert.ok(audioDetails);
    assert.equal(videoDetails.pixelFormat, "yuv420p");
    assert.equal(videoDetails.colorTransfer, "bt709");
    assert.equal(videoDetails.colorPrimaries, "bt709");
    assert.equal(videoDetails.colorSpace, "bt709");
    assert.equal(videoDetails.colorRange, "tv");
    assert.equal(audioDetails.channelLayout, "mono");

    const encodedBytes = await readFile(encodedPath);
    assert.ok(encodedBytes.byteLength > 0);
    assert.equal(encoded.metadata.sizeBytes, encodedBytes.byteLength);

    // Decode both streams completely, treating decoding errors as failures.
    await runNativeProcess({
      executable: tools.ffmpeg.path,
      cwd: configuration.cwd,
      signal: controller.signal,
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
        encodedPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-f",
        "null",
        "-",
      ],
    });

    console.log("Real native MP4 encoding and decoding check passed.");

    // Verify preservation directly; FFmpeg builds can report refusal
    // with either a zero or nonzero exit status.
    const occupiedPath = join(directory, "occupied output.mp4");
    const sentinel = Buffer.from("Existing output must remain unchanged.\n");

    await writeFile(occupiedPath, sentinel, { flag: "wx" });

    let refusalResult;

    try {
      refusalResult = await runNativeProcess({
        ...encodeOptions,
        args: [...command.slice(0, -1), occupiedPath],
      });
    } catch (error) {
      assert.equal(error.reason, "NONZERO_EXIT");
    }

    if (refusalResult !== undefined) {
      assert.match(refusalResult.stderr, /already exists/i);
    }

    assert.deepEqual(await readFile(occupiedPath), sentinel);
    assert.deepEqual(await readFile(encodedPath), encodedBytes);
    assert.deepEqual(new Uint8Array(await readFile(mediaPath)), bytes);

    console.log("Native intermediate-output overwrite protection passed.");
    byteWorkspace = await createNativeWorkspace();
    const byteOutputPath = byteWorkspace.getOutputPath();
    const originalBytes = new Uint8Array(bytes);

    const prepared = await prepareNativeMp4Bytes({
      configuration,
      tools,
      inventory,
      plan: {
        input: {
          kind: "bytes",
          bytes,
          name: "fixture.mp4",
        },
        transformations: [
          {
            type: "compress",
            options: { preset: "video-balanced-v1" },
          },
        ],
        terminal: {
          type: "export",
          format: "mp4",
          preset: "video-balanced-v1",
        },
        output: { kind: "bytes" },
      },
      workspace: byteWorkspace,
      context,
    });

    assert.equal(prepared.bytes.constructor, Uint8Array);
    assert.ok(prepared.bytes.byteLength > 0);
    assert.equal(prepared.bytes.byteLength, prepared.metadata.sizeBytes);
    assert.deepEqual(bytes, originalBytes);

    // Decode the actual output produced by the combined helper.
    await runNativeProcess({
      executable: tools.ffmpeg.path,
      cwd: configuration.cwd,
      signal: controller.signal,
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
        byteOutputPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-f",
        "null",
        "-",
      ],
    });

    // Dispose before consuming the returned bytes again.
    await byteWorkspace.dispose();
    byteWorkspace = undefined;

    await assert.rejects(access(dirname(byteOutputPath)), {
      code: "ENOENT",
    });

    const returnedMetadata = await client
      .from({
        kind: "bytes",
        bytes: prepared.bytes,
        name: "returned-output.mp4",
      })
      .metadata({ signal: controller.signal });

    assert.deepEqual(returnedMetadata, prepared.metadata);
    assert.deepEqual(bytes, originalBytes);
    controller.signal.throwIfAborted();

    console.log("Integrated native byte export and decoding passed.");
    console.log("Returned output bytes remain valid after workspace cleanup.");

    const publicExport = await client
      .from({ kind: "bytes", bytes, name: "fixture.mp4" })
      .compress({ preset: "video-balanced-v1" })
      .export({ format: "mp4", output: { kind: "bytes" } }, { signal: controller.signal });

    assert.equal(publicExport.output.kind, "bytes");
    assert.ok(publicExport.output.bytes.byteLength > 0);

    const publicOutputMetadata = await client
      .from({ kind: "bytes", bytes: publicExport.output.bytes })
      .metadata({ signal: controller.signal });

    assert.deepEqual(publicOutputMetadata, publicExport.metadata);
    assert.deepEqual(bytes, originalBytes);

    console.log("Public native MP4 byte export passed.");

    const publicTarget = join(directory, "public path export.mp4");

    const pathPipeline = client
      .from({ kind: "bytes", bytes, name: "fixture.mp4" })
      .compress({ preset: "video-balanced-v1" });

    const pathExport = await pathPipeline.export(
      { format: "mp4", output: { kind: "path", path: publicTarget } },
      { signal: controller.signal },
    );

    assert.deepEqual(pathExport.output, {
      kind: "path",
      path: publicTarget,
    });
    assert.equal(pathExport.warnings, undefined);

    const publishedMetadata = await client
      .from({ kind: "path", path: publicTarget })
      .metadata({ signal: controller.signal });

    assert.deepEqual(publishedMetadata, pathExport.metadata);

    const publishedBytes = await readFile(publicTarget);

    await assert.rejects(
      pathPipeline.export(
        { format: "mp4", output: { kind: "path", path: publicTarget } },
        { signal: controller.signal },
      ),
      { code: "OUTPUT_EXISTS" },
    );

    assert.deepEqual(await readFile(publicTarget), publishedBytes);
    assert.deepEqual(bytes, originalBytes);

    console.log("Public native MP4 path export and overwrite rejection passed.");

    const trimPath = join(directory, "trimmed fixture.mp4");

    const trimFilters = buildNativeTrimFilters(
      { startSeconds: 0.5, endSeconds: 1.5 },
      sourceDetails.formatStartTimeSeconds,
      true,
      inventory,
    );

    assert.ok(trimFilters.audio);

    // Assemble an experimental command without changing public capabilities.
    const trimBase = buildNativeMp4Command({
      ...commandOptions,
      outputPath: trimPath,
    });

    const trimCommand = [
      ...trimFilters.inputArgs,
      ...trimBase.slice(0, -1),
      "-vf",
      trimFilters.video,
      "-af",
      trimFilters.audio,
      ...trimFilters.mp4OutputArgs,
      trimPath,
    ];

    const trimRun = await runNativeProcess({
      executable: tools.ffmpeg.path,
      cwd: configuration.cwd,
      signal: controller.signal,
      maxOutputBytes: 1_048_576,
      args: trimCommand,
    });

    assert.equal(trimRun.stderr.trim(), "");

    const trimmed = await probeNativeFileDetails(configuration, tools, trimPath, context);

    validateNativeMp4Output(
      trimmed,
      {
        width: 320,
        height: 180,
        audio: {
          sampleRate: 48000,
          channels: 1,
          channelLayout: "mono",
        },
      },
      context.jobId,
    );

    assert.ok(
      trimmed.metadata.durationSeconds >= 0.95 && trimmed.metadata.durationSeconds <= 1.1,
      `Unexpected trimmed duration: ${trimmed.metadata.durationSeconds}`,
    );

    // Inspect decoded video-frame presentation timestamps.
    const frameProbe = await runNativeProcess({
      executable: tools.ffprobe.path,
      cwd: configuration.cwd,
      signal: controller.signal,
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
        "frame=best_effort_timestamp_time",
        "-of",
        "json",
        "-i",
        trimPath,
      ],
    });

    assert.equal(frameProbe.stderr.trim(), "");

    const frameReport = JSON.parse(frameProbe.stdout);
    assert.ok(Array.isArray(frameReport.frames));
    assert.equal(frameReport.frames.length, 24);

    for (const [index, frame] of frameReport.frames.entries()) {
      assert.equal(typeof frame.best_effort_timestamp_time, "string");

      const timestamp = Number(frame.best_effort_timestamp_time);
      assert.ok(Number.isFinite(timestamp));

      assert.ok(
        Math.abs(timestamp - index / 24) <= 0.000002,
        `Unexpected timestamp for trimmed frame ${index}: ${timestamp}`,
      );
    }

    // Decode both output streams completely.
    const trimDecode = await runNativeProcess({
      executable: tools.ffmpeg.path,
      cwd: configuration.cwd,
      signal: controller.signal,
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
        trimPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-f",
        "null",
        "-",
      ],
    });

    assert.equal(trimDecode.stderr.trim(), "");
    assert.deepEqual(new Uint8Array(await readFile(mediaPath)), originalBytes);
    controller.signal.throwIfAborted();

    console.log("Native trim frame-count and timestamp check passed.");
    console.log("Native trimmed audio/video decoding passed.");

    await checkNativeTrimSelection({
      configuration,
      tools,
      inventory,
      mediaPath,
      sourceOriginSeconds: sourceDetails.formatStartTimeSeconds,
      context,
    });

    assert.equal(byteWorkspace, undefined);
    byteWorkspace = await createNativeWorkspace();

    const smallWorkspaceDirectory = dirname(byteWorkspace.getOutputPath());

    const smallPrepared = await checkNativeSmallPreset({
      configuration,
      tools,
      inventory,
      mediaPath,
      workspace: byteWorkspace,
      context,
      client,
      directory,
    });

    await byteWorkspace.dispose();
    byteWorkspace = undefined;

    await assert.rejects(access(smallWorkspaceDirectory), {
      code: "ENOENT",
    });

    const smallReturnedMetadata = await client
      .from({
        kind: "bytes",
        bytes: smallPrepared.bytes,
        name: "small preset output.mp4",
      })
      .metadata({ signal: context.signal });

    assert.deepEqual(smallReturnedMetadata, smallPrepared.metadata);

    console.log("Native small-preset bytes remain valid after workspace cleanup.");

    // Reuse the existing cleanup-tracked workspace variable.
    assert.equal(byteWorkspace, undefined);
    byteWorkspace = await createNativeWorkspace();

    const fractionalPath = byteWorkspace.getOutputPath();
    const fractionalWorkspaceDirectory = dirname(fractionalPath);
    const fractionalTarget = join(directory, "fractional final target.mp4");

    const fractionalPlan = {
      ...commandOptions.plan,
      input: { kind: "path", path: mediaPath },
      transformations: [
        { type: "trim", options: { start: 0.51, end: 1.49 } },
        ...commandOptions.plan.transformations,
      ],
      output: { kind: "path", path: fractionalTarget },
    };

    const preparationOptions = {
      configuration,
      tools,
      inventory,
      plan: fractionalPlan,
      workspace: byteWorkspace,
      context,
    };

    // A valid time interval that contains no video frames.
    await assert.rejects(
      prepareNativeMp4File({
        ...preparationOptions,
        plan: {
          ...fractionalPlan,
          transformations: [
            { type: "trim", options: { start: 0.001, end: 0.002 } },
            ...commandOptions.plan.transformations,
          ],
        },
      }),
      (error) => {
        assert.equal(error.code, "INVALID_OPTIONS");
        assert.equal(error.details.reason, "RANGE_TOO_SHORT");
        assert.equal(error.details.streamKind, "video");
        return true;
      },
    );

    // Rejection must happen before an intermediate output is created.
    await assert.rejects(access(fractionalPath), { code: "ENOENT" });
    await assert.rejects(access(fractionalTarget), { code: "ENOENT" });

    console.log("Integrated empty trim rejected before output creation.");

    // The same workspace remains usable after pre-encoding rejection.
    const fractionalPrepared = await prepareNativeMp4File(preparationOptions);

    assert.equal(fractionalPrepared.path, fractionalPath);
    assert.notEqual(fractionalPrepared.path, fractionalTarget);

    const fractionalOutputStat = await stat(fractionalPath);
    assert.ok(fractionalOutputStat.isFile());
    assert.ok(fractionalOutputStat.size > 0);
    assert.equal(fractionalPrepared.metadata.sizeBytes, fractionalOutputStat.size);

    // Preparation returns staging; publication belongs to the caller.
    await assert.rejects(access(fractionalTarget), { code: "ENOENT" });

    console.log("Integrated native trimmed file preparation passed.");

    const emptyPublicTarget = join(directory, "empty public trim.mp4");

    await assert.rejects(
      client
        .from({ kind: "path", path: mediaPath })
        .trim({ start: 0.001, end: 0.002 })
        .compress({ preset: "video-balanced-v1" })
        .export(
          {
            format: "mp4",
            output: { kind: "path", path: emptyPublicTarget },
          },
          { signal: context.signal },
        ),
      (error) => {
        assert.equal(error.code, "INVALID_OPTIONS");
        assert.equal(error.details.reason, "RANGE_TOO_SHORT");
        assert.equal(error.details.streamKind, "video");
        return true;
      },
    );

    await assert.rejects(access(emptyPublicTarget), { code: "ENOENT" });

    console.log("Public empty trim rejection passed.");

    // A valid export must still succeed on the same client after rejection.
    const publicTrimTarget = join(directory, "public fractional trim.mp4");
    const publicTrimPipeline = client
      .from({ kind: "path", path: mediaPath })
      .trim({ start: 0.51, end: 1.49 })
      .compress({ preset: "video-balanced-v1" });

    const publicTrim = await publicTrimPipeline.export(
      {
        format: "mp4",
        output: { kind: "path", path: publicTrimTarget },
      },
      { signal: context.signal },
    );

    assert.equal(publicTrim.output.kind, "path");
    assert.equal(publicTrim.output.path, publicTrimTarget);
    assert.equal(publicTrim.warnings?.length ?? 0, 0);

    const publicTrimBytes = await readFile(publicTrimTarget);
    assert.ok(publicTrimBytes.byteLength > 0);
    assert.equal(publicTrim.metadata.sizeBytes, publicTrimBytes.byteLength);

    const publicTrimMetadata = await client
      .from({ kind: "path", path: publicTrimTarget })
      .metadata({ signal: context.signal });

    assert.deepEqual(publicTrimMetadata, publicTrim.metadata);

    await assert.rejects(
      publicTrimPipeline.export(
        {
          format: "mp4",
          output: { kind: "path", path: publicTrimTarget },
        },
        { signal: context.signal },
      ),
      { code: "OUTPUT_EXISTS" },
    );

    assert.deepEqual(await readFile(publicTrimTarget), publicTrimBytes);

    console.log("Public native trim export, recovery, and overwrite protection passed.");

    const publicTrimInputBytes = new Uint8Array(await readFile(mediaPath));
    const publicTrimInputSnapshot = publicTrimInputBytes.slice();

    const publicByteTrim = await client
      .from({
        kind: "bytes",
        bytes: publicTrimInputBytes,
        name: "trim source.mp4",
      })
      .trim({ start: 0.51, end: 1.49 })
      .compress({ preset: "video-balanced-v1" })
      .export(
        {
          format: "mp4",
          output: { kind: "bytes" },
        },
        { signal: context.signal },
      );

    assert.equal(publicByteTrim.output.kind, "bytes");
    assert.ok(publicByteTrim.output.bytes instanceof Uint8Array);
    assert.ok(publicByteTrim.output.bytes.byteLength > 0);
    assert.equal(publicByteTrim.metadata.sizeBytes, publicByteTrim.output.bytes.byteLength);
    assert.equal(publicByteTrim.warnings?.length ?? 0, 0);
    assert.deepEqual(publicTrimInputBytes, publicTrimInputSnapshot);

    const publicByteTrimSnapshot = publicByteTrim.output.bytes.slice();

    // Export has returned after its workspace cleanup.
    // Probe the returned bytes through a new public operation.
    const publicByteTrimMetadata = await client
      .from({
        kind: "bytes",
        bytes: publicByteTrim.output.bytes,
        name: "trimmed.mp4",
      })
      .metadata({ signal: context.signal });

    assert.deepEqual(publicByteTrimMetadata, publicByteTrim.metadata);
    assert.deepEqual(publicByteTrim.output.bytes, publicByteTrimSnapshot);

    // Save a separate verification copy for the existing FFprobe checks.
    const publicByteTrimPath = join(directory, "public byte trim verification.mp4");

    await writeFile(publicByteTrimPath, publicByteTrim.output.bytes, {
      flag: "wx",
    });

    console.log("Public native byte-input trim export passed.");
    console.log("Returned trimmed bytes remain valid after export cleanup.");

    const fractionalFrameProbe = await runNativeProcess({
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
        "frame=best_effort_timestamp_time",
        "-of",
        "json",
        "-i",
        publicByteTrimPath,
      ],
    });

    assert.equal(fractionalFrameProbe.stderr.trim(), "");

    const fractionalFrames = JSON.parse(fractionalFrameProbe.stdout).frames;

    assert.ok(Array.isArray(fractionalFrames));
    assert.equal(fractionalFrames.length, 23);

    for (const [index, frame] of fractionalFrames.entries()) {
      const timestamp = frame.best_effort_timestamp_time;

      assert.equal(typeof timestamp, "string");
      assert.notEqual(timestamp.trim(), "");

      const actual = Number(timestamp);
      const expected = (13 + index) / 24 - 0.51;

      assert.ok(Number.isFinite(actual));
      assert.ok(
        Math.abs(actual - expected) <= 0.000003,
        `Fractional frame ${index}: expected ${expected}, received ${actual}`,
      );
    }

    const fractionalDecode = await runNativeProcess({
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
        publicByteTrimPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-f",
        "null",
        "-",
      ],
    });

    assert.equal(fractionalDecode.stderr.trim(), "");
    context.signal.throwIfAborted();

    console.log("Fractional MP4 video timestamps passed.");
    console.log("Fractional MP4 audio/video decoding passed.");

    const fractionalAudioProbe = await runNativeProcess({
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
        "a:0",
        "-show_streams",
        "-show_frames",
        "-show_entries",
        "stream=codec_name,sample_rate,channels,time_base,start_pts,duration_ts:frame=pts,nb_samples",
        "-of",
        "json",
        "-i",
        publicByteTrimPath,
      ],
    });

    assert.equal(fractionalAudioProbe.stderr.trim(), "");

    const fractionalAudio = JSON.parse(fractionalAudioProbe.stdout);

    assert.ok(Array.isArray(fractionalAudio.streams));
    assert.equal(fractionalAudio.streams.length, 1);

    const audioStream = fractionalAudio.streams[0];

    assert.equal(audioStream.codec_name, "aac");
    assert.equal(audioStream.sample_rate, "48000");
    assert.equal(audioStream.channels, 1);
    assert.equal(audioStream.time_base, "1/48000");
    assert.equal(audioStream.start_pts, 0);

    const requestedSamples = 47_040;

    // With a 1/48000 time base, duration ticks equal audio samples.
    assert.equal(audioStream.duration_ts, requestedSamples);

    assert.ok(Array.isArray(fractionalAudio.frames));
    assert.ok(fractionalAudio.frames.length > 0);

    let decodedSamples = 0;

    for (const [index, frame] of fractionalAudio.frames.entries()) {
      assert.ok(Number.isSafeInteger(frame.pts), `Audio frame ${index} has no valid timestamp`);
      assert.ok(
        Number.isSafeInteger(frame.nb_samples) && frame.nb_samples > 0,
        `Audio frame ${index} has no valid sample count`,
      );

      // The first decoded sample starts at zero.
      // Every subsequent frame must continue without a gap or overlap.
      assert.equal(
        frame.pts,
        decodedSamples,
        `Audio frame ${index} has a timestamp gap or overlap`,
      );

      decodedSamples += frame.nb_samples;
    }

    assert.ok(
      decodedSamples >= requestedSamples,
      `Decoded audio is short: ${decodedSamples}/${requestedSamples} samples`,
    );

    const extraDecodedSamples = decodedSamples - requestedSamples;

    console.table({
      requestedSamples,
      declaredSamples: audioStream.duration_ts,
      decodedSamples,
      extraDecodedSamples,
    });

    console.log("Fractional AAC declared duration and continuity passed.");

    if (extraDecodedSamples === 0) {
      console.log("Fractional AAC decoded sample count matches the request.");
    } else {
      console.log(
        `Fractional AAC has ${extraDecodedSamples} decoded samples beyond the declared duration; padding handling remains unresolved.`,
      );
    }

    await byteWorkspace.dispose();
    byteWorkspace = undefined;

    await assert.rejects(access(fractionalWorkspaceDirectory), {
      code: "ENOENT",
    });
    await assert.rejects(access(fractionalTarget), {
      code: "ENOENT",
    });

    console.log("Integrated trim staging cleanup passed.");

    assert.deepEqual(await readFile(publicTrimTarget), publicTrimBytes);
    await assert.rejects(access(emptyPublicTarget), { code: "ENOENT" });

    console.log("Public trimmed output remains valid after staging cleanup.");

    // Create a video-only source from the known fixture without re-encoding.
    const videoOnlySourcePath = join(directory, "video-only source.mp4");

    const videoOnlyRemux = await runNativeProcess({
      executable: tools.ffmpeg.path,
      cwd: configuration.cwd,
      signal: context.signal,
      maxOutputBytes: 1_048_576,
      args: [
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-n",
        "-protocol_whitelist",
        "file",
        "-i",
        mediaPath,
        "-map",
        "0:v:0",
        "-an",
        "-c:v",
        "copy",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        videoOnlySourcePath,
      ],
    });

    assert.equal(videoOnlyRemux.stderr.trim(), "");

    const videoOnlySourceMetadata = await client
      .from({ kind: "path", path: videoOnlySourcePath })
      .metadata({ signal: context.signal });

    assert.equal(videoOnlySourceMetadata.streams.length, 1);
    assert.equal(videoOnlySourceMetadata.streams[0].kind, "video");

    // First trim: source [0.25, 1.75).
    // Second trim: relative [0.26, 1.24).
    // Combined selection: source [0.51, 1.49).
    const consecutiveTrim = await client
      .from({ kind: "path", path: videoOnlySourcePath })
      .trim({ start: 0.25, end: 1.75 })
      .trim({ start: 0.26, end: 1.24 })
      .compress({ preset: "video-balanced-v1" })
      .export(
        {
          format: "mp4",
          output: { kind: "bytes" },
        },
        { signal: context.signal },
      );

    assert.equal(consecutiveTrim.output.kind, "bytes");
    assert.equal(consecutiveTrim.metadata.streams.length, 1);
    assert.equal(consecutiveTrim.metadata.streams[0].kind, "video");
    assert.equal(consecutiveTrim.metadata.streams[0].codec, "h264");

    const consecutiveTrimPath = join(directory, "consecutive video trim.mp4");

    await writeFile(consecutiveTrimPath, consecutiveTrim.output.bytes, {
      flag: "wx",
    });

    const consecutiveProbe = await runNativeProcess({
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
        "stream=codec_type:frame=media_type,best_effort_timestamp_time",
        "-of",
        "json",
        "-i",
        consecutiveTrimPath,
      ],
    });

    assert.equal(consecutiveProbe.stderr.trim(), "");

    const consecutiveDetails = JSON.parse(consecutiveProbe.stdout);

    assert.equal(consecutiveDetails.streams.length, 1);
    assert.equal(consecutiveDetails.streams[0].codec_type, "video");
    assert.equal(consecutiveDetails.frames.length, 23);

    for (const [index, frame] of consecutiveDetails.frames.entries()) {
      assert.equal(frame.media_type, "video");
      assert.equal(typeof frame.best_effort_timestamp_time, "string");
      assert.notEqual(frame.best_effort_timestamp_time.trim(), "");

      const actual = Number(frame.best_effort_timestamp_time);
      const expected = (13 + index) / 24 - 0.51;

      assert.ok(Number.isFinite(actual));
      assert.ok(
        Math.abs(actual - expected) <= 0.000003,
        `Consecutive trim frame ${index}: expected ${expected}, received ${actual}`,
      );
    }

    context.signal.throwIfAborted();

    console.log("Public video-only trim introduces no audio.");
    console.log("Public consecutive trim frame count and timestamps passed.");

    // Keep the two-second video, but retain only 0.25 seconds of audio.
    const shortAudioSourcePath = join(directory, "short-audio source.mp4");

    const shortAudioCreation = await runNativeProcess({
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
        "-n",
        "-protocol_whitelist",
        "file",
        "-i",
        mediaPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-c:v",
        "copy",
        "-af",
        "atrim=end=0.25",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        shortAudioSourcePath,
      ],
    });

    assert.equal(shortAudioCreation.stderr.trim(), "");

    const shortAudioSourceSnapshot = await readFile(shortAudioSourcePath);
    const shortAudioMetadata = await client
      .from({ kind: "path", path: shortAudioSourcePath })
      .metadata({ signal: context.signal });

    assert.equal(shortAudioMetadata.streams.length, 2);
    assert.equal(shortAudioMetadata.streams.filter((stream) => stream.kind === "audio").length, 1);
    assert.ok(shortAudioMetadata.durationSeconds >= 1.9);

    const emptyAudioTarget = join(directory, "empty-audio trim.mp4");

    await assert.rejects(
      client
        .from({ kind: "path", path: shortAudioSourcePath })
        .trim({ start: 0.51, end: 1.49 })
        .compress({ preset: "video-balanced-v1" })
        .export(
          {
            format: "mp4",
            output: { kind: "path", path: emptyAudioTarget },
          },
          { signal: context.signal },
        ),
      (error) => {
        assert.equal(error.code, "INVALID_OPTIONS");
        assert.equal(error.details.reason, "RANGE_TOO_SHORT");
        assert.equal(error.details.streamKind, "audio");
        return true;
      },
    );

    await assert.rejects(access(emptyAudioTarget), { code: "ENOENT" });
    assert.deepEqual(await readFile(shortAudioSourcePath), shortAudioSourceSnapshot);

    console.log("Public trim rejects an interval with no required audio samples.");

    // Both streams contain content in this earlier interval.
    // Verify recovery using the same source and client.
    const audioRecovery = await client
      .from({ kind: "path", path: shortAudioSourcePath })
      .trim({ start: 0, end: 0.125 })
      .compress({ preset: "video-balanced-v1" })
      .export(
        {
          format: "mp4",
          output: { kind: "bytes" },
        },
        { signal: context.signal },
      );

    assert.equal(audioRecovery.output.kind, "bytes");
    assert.ok(audioRecovery.output.bytes.byteLength > 0);
    assert.equal(audioRecovery.metadata.streams.length, 2);
    assert.equal(
      audioRecovery.metadata.streams.filter((stream) => stream.kind === "audio").length,
      1,
    );

    const audioRecoveryMetadata = await client
      .from({
        kind: "bytes",
        bytes: audioRecovery.output.bytes,
        name: "audio recovery.mp4",
      })
      .metadata({ signal: context.signal });

    assert.deepEqual(audioRecoveryMetadata, audioRecovery.metadata);
    await assert.rejects(access(emptyAudioTarget), { code: "ENOENT" });

    context.signal.throwIfAborted();

    console.log("Public trim recovers after empty-audio rejection.");

    // This fixture is unrotated and has square pixels.
    const resizeSourceDimensions = validateNativeResizeSource(sourceDetails);

    const resizeFilters = buildNativeResizeFilters(
      {
        width: resizeSourceDimensions.width,
        height: resizeSourceDimensions.height,
      },
      [
        { type: "resize", options: { width: 101, height: 101 } },
        { type: "resize", options: { width: 80, height: 80 } },
      ],
      inventory,
    );

    assert.ok(resizeFilters);
    assert.deepEqual(resizeFilters.dimensions, { width: 80, height: 44 });

    assert.equal(byteWorkspace, undefined);
    byteWorkspace = await createNativeWorkspace();

    const resizedPath = byteWorkspace.getOutputPath();
    const resizeWorkspaceDirectory = dirname(resizedPath);
    const resizeFinalTarget = join(directory, "resize final target.mp4");

    const resizePlan = {
      ...commandOptions.plan,
      input: { kind: "path", path: mediaPath },
      transformations: [
        { type: "resize", options: { width: 101, height: 101 } },
        { type: "resize", options: { width: 80, height: 80 } },
        ...commandOptions.plan.transformations,
      ],
      output: { kind: "path", path: resizeFinalTarget },
    };

    const resizePreparationOptions = {
      configuration,
      tools,
      inventory,
      plan: resizePlan,
      workspace: byteWorkspace,
      context,
    };

    // Alignment cannot produce a nonzero output within a 1×1 box.
    await assert.rejects(
      prepareNativeMp4File({
        ...resizePreparationOptions,
        plan: {
          ...resizePlan,
          transformations: [
            { type: "resize", options: { width: 1, height: 1 } },
            ...commandOptions.plan.transformations,
          ],
        },
      }),
      (error) => {
        assert.equal(error.code, "INVALID_OPTIONS");
        assert.equal(error.details.reason, "INVALID_DIMENSIONS");
        return true;
      },
    );

    await assert.rejects(access(resizedPath), { code: "ENOENT" });
    await assert.rejects(access(resizeFinalTarget), { code: "ENOENT" });

    console.log("Integrated invalid resize rejected before output creation.");

    const resizedPrepared = await prepareNativeMp4File(resizePreparationOptions);

    assert.equal(resizedPrepared.path, resizedPath);

    const preparedResizeVideo = resizedPrepared.metadata.streams.find(
      (stream) => stream.kind === "video",
    );

    assert.ok(preparedResizeVideo);
    assert.equal(preparedResizeVideo.width, 80);
    assert.equal(preparedResizeVideo.height, 44);
    assert.equal(resizedPrepared.metadata.sizeBytes, (await stat(resizedPath)).size);

    // File preparation must not publish the final target.
    await assert.rejects(access(resizeFinalTarget), { code: "ENOENT" });

    console.log("Integrated native resize preparation passed.");

    const publicResizeTarget = join(directory, "public resized.mp4");

    const publicResizePipeline = client
      .from({ kind: "path", path: mediaPath })
      .resize({ width: 101, height: 101 })
      .resize({ width: 80, height: 80 })
      .compress({ preset: "video-balanced-v1" });

    const publicResize = await publicResizePipeline.export(
      {
        format: "mp4",
        output: { kind: "path", path: publicResizeTarget },
      },
      { signal: context.signal },
    );

    assert.equal(publicResize.output.kind, "path");
    assert.equal(publicResize.output.path, publicResizeTarget);
    assert.equal(publicResize.warnings?.length ?? 0, 0);

    const publicResizeVideo = publicResize.metadata.streams.find(
      (stream) => stream.kind === "video",
    );

    assert.ok(publicResizeVideo);
    assert.equal(publicResizeVideo.width, 80);
    assert.equal(publicResizeVideo.height, 44);

    const publicResizeBytes = await readFile(publicResizeTarget);
    assert.ok(publicResizeBytes.byteLength > 0);
    assert.equal(publicResize.metadata.sizeBytes, publicResizeBytes.byteLength);

    const publicResizeMetadata = await client
      .from({ kind: "path", path: publicResizeTarget })
      .metadata({ signal: context.signal });

    assert.deepEqual(publicResizeMetadata, publicResize.metadata);

    await assert.rejects(
      publicResizePipeline.export(
        {
          format: "mp4",
          output: { kind: "path", path: publicResizeTarget },
        },
        { signal: context.signal },
      ),
      { code: "OUTPUT_EXISTS" },
    );

    assert.deepEqual(await readFile(publicResizeTarget), publicResizeBytes);

    console.log("Public native resize export and overwrite protection passed.");

    const resizedDetails = await probeNativeFileDetails(
      configuration,
      tools,
      publicResizeTarget,
      context,
    );

    validateNativeMp4Output(
      resizedDetails,
      {
        width: 80,
        height: 44,
        audio: {
          sampleRate: 48000,
          channels: 1,
          channelLayout: "mono",
        },
      },
      context.jobId,
    );

    const resizedVideo = resizedDetails.metadata.streams.find((stream) => stream.kind === "video");
    assert.ok(resizedVideo);

    const resizedVideoDetails = resizedDetails.streams.find(
      (stream) => stream.index === resizedVideo.index,
    );

    assert.equal(resizedVideoDetails.sampleAspectRatio, "1:1");

    const resizedFrameProbe = await runNativeProcess({
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
        publicResizeTarget,
      ],
    });

    assert.equal(resizedFrameProbe.stderr.trim(), "");

    const resizedFrames = JSON.parse(resizedFrameProbe.stdout).frames;
    assert.ok(Array.isArray(resizedFrames));
    assert.equal(resizedFrames.length, 48);

    for (const [index, frame] of resizedFrames.entries()) {
      assert.equal(frame.width, 80);
      assert.equal(frame.height, 44);
      assert.equal(typeof frame.best_effort_timestamp_time, "string");
      assert.notEqual(frame.best_effort_timestamp_time.trim(), "");

      const actual = Number(frame.best_effort_timestamp_time);
      const expected = index / 24;

      assert.ok(Number.isFinite(actual));
      assert.ok(
        Math.abs(actual - expected) <= 0.000002,
        `Resized frame ${index}: expected ${expected}, received ${actual}`,
      );
    }

    const resizedDecode = await runNativeProcess({
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
        publicResizeTarget,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-f",
        "null",
        "-",
      ],
    });

    assert.equal(resizedDecode.stderr.trim(), "");
    context.signal.throwIfAborted();

    console.log("Native consecutive resize dimensions and square pixels passed.");
    console.log("Native resize preserves video frame count and timestamps.");
    console.log("Native resized audio/video decoding passed.");

    await byteWorkspace.dispose();
    byteWorkspace = undefined;

    await assert.rejects(access(resizeWorkspaceDirectory), {
      code: "ENOENT",
    });
    await assert.rejects(access(resizeFinalTarget), {
      code: "ENOENT",
    });

    console.log("Integrated resize staging cleanup passed.");

    assert.deepEqual(await readFile(publicResizeTarget), publicResizeBytes);

    console.log("Public resized output remains valid after staging cleanup.");

    for (const preset of ["video-balanced-v1", "video-small-v1"]) {
      await checkNativeTrimResize({
        configuration,
        tools,
        client,
        mediaPath,
        directory,
        context,
        preset,
      });
    }

    assert.deepEqual(publicByteTrim.output.bytes, publicByteTrimSnapshot);
    assert.deepEqual(publicTrimInputBytes, publicTrimInputSnapshot);

    console.log("Public trimmed bytes and source bytes remain unchanged.");

    context.signal.throwIfAborted();
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    clearTimeout(timer);

    if (byteWorkspace !== undefined) {
      try {
        await byteWorkspace.dispose();
      } catch (error) {
        if (primaryFailed) {
          console.error("Byte-export workspace cleanup also failed:", error);
        } else {
          cleanupFailure ??= new Error("Byte-export workspace cleanup failed.", {
            cause: error,
          });
        }
      }
    }

    if (client !== undefined) {
      try {
        await client.dispose();
      } catch (error) {
        if (primaryFailed) {
          console.error("Client disposal also failed:", error);
        } else {
          cleanupFailure ??= new Error("Client disposal failed.", {
            cause: error,
          });
        }
      }
    }

    if (directory !== undefined) {
      try {
        const target = resolve(directory);

        // Remove only the dedicated directory created by this invocation.
        assert.equal(dirname(target), temporaryRoot);
        assert.ok(basename(target).startsWith("mavio-native-media-"));

        await rm(target, { recursive: true, force: true });
      } catch (cleanupError) {
        if (primaryFailed) {
          console.error(
            "Temporary-file cleanup also failed:",
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          );
        } else {
          cleanupFailure ??= new Error("Temporary-file cleanup failed.", {
            cause: cleanupError,
          });
        }
      }
    }
  }

  if (cleanupFailure !== undefined) {
    throw cleanupFailure;
  }

  console.log("Public native metadata and recovery check passed.");
  console.log("Invalid-media rejection passed.");
  console.log("Temporary files removed.");
}

try {
  await main();
} catch (error) {
  console.error("Native media check failed.");
  console.error(error instanceof Error ? error.message : String(error));

  if (error?.code) console.error(`Code: ${error.code}`);
  if (error?.reason) console.error(`Reason: ${error.reason}`);
  if (error?.details) {
    console.error(JSON.stringify(error.details, null, 2));
  }

  process.exitCode = 1;
}
