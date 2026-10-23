import { FFmpeg } from "/wrapper/index.js";
import { createMavio } from "/mavio.mjs";
import { discoverBrowserInventory } from "../packages/mavio/dist/engines/browser/inventory.js";
import { createBrowserWorkspace } from "../packages/mavio/dist/engines/browser/workspace.js";
import { prepareBrowserMp4Bytes } from "../packages/mavio/dist/engines/browser/mp4-bytes.js";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function equalBytes(actual, expected, message) {
  check(
    actual instanceof Uint8Array &&
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]),
    message,
  );
}

function measureLumaQuality(reference, actual, width, height, frames, preset) {
  const pixels = width * height;
  const frameBytes = (pixels * 3) / 2;
  check(
    reference instanceof Uint8Array && actual instanceof Uint8Array,
    "Expected raw source and output video.",
  );
  check(
    reference.length === frameBytes * frames && actual.length === reference.length,
    "Quality comparison requires matching dimensions and frame counts.",
  );

  let squaredError = 0;
  for (let frame = 0; frame < frames; frame++) {
    const offset = frame * frameBytes;
    for (let pixel = 0; pixel < pixels; pixel++) {
      const difference = reference[offset + pixel] - actual[offset + pixel];
      squaredError += difference * difference;
    }
  }

  const mse = squaredError / (pixels * frames);
  const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  check(psnr === Infinity || Number.isFinite(psnr), "Invalid luma PSNR.");
  const minimumQuality = {
    "video-balanced-v1": 38,
    "video-small-v1": 34,
  }[preset];
  check(minimumQuality !== undefined, "Unknown quality-gate preset.");
  check(
    psnr >= minimumQuality,
    "Luma quality regression for " +
      preset +
      ": measured " +
      psnr +
      " dB; minimum " +
      minimumQuality +
      " dB.",
  );

  return {
    minimumLumaPSNRdB: minimumQuality,
    lumaMSE: Number(mse.toFixed(6)),
    lumaPSNRdB: psnr === Infinity ? "identical" : Number(psnr.toFixed(4)),
  };
}

async function preparePublicResizeCases(origin, sourceBytes, cases, preset, operation = "convert") {
  const client = createMavio({
    initTimeoutMs: 60_000,
    browser: {
      assets: {
        coreURL: new URL("/core/ffmpeg-core.js", origin).href,
        wasmURL: new URL("/core/ffmpeg-core.wasm", origin).href,
        classWorkerURL: new URL("/wrapper/worker.js", origin).href,
      },
    },
  });

  const outputs = [];

  try {
    for (const item of cases) {
      for (const inputKind of ["bytes", "blob"]) {
        for (const outputKind of ["bytes", "blob"]) {
          const input =
            inputKind === "bytes"
              ? { kind: "bytes", bytes: sourceBytes }
              : {
                  kind: "blob",
                  blob: new Blob([sourceBytes], { type: "video/mp4" }),
                };

          let pipeline = client.from(input);

          for (const operation of item.transformations) {
            if (operation.type === "resize") {
              pipeline = pipeline.resize(operation.options);
            } else if (operation.type === "trim") {
              pipeline = pipeline.trim(operation.options);
            } else {
              throw new Error("Unexpected public resize transformation.");
            }
          }

          const encoded =
            operation === "compress"
              ? pipeline.compress({ preset })
              : pipeline.convert({ format: "mp4", preset });

          const result = await encoded.export({
            format: "mp4",
            output: { kind: outputKind },
          });

          check(result.output.kind === outputKind, "Public output kind differs.");
          check(result.engine.id === "browser-ffmpeg", "Unexpected public engine.");

          if (outputKind === "blob") {
            check(result.output.blob.type === "video/mp4", "Unexpected Blob MIME type.");
          }

          outputs.push({
            ...item,
            baseCase: item.name,
            name: item.name + "-" + inputKind + "-" + outputKind,
            blobInput: inputKind === "blob",
            inputKind,
            outputKind,
            input,
            result,
          });
        }
      }
    }
  } finally {
    await client.dispose();
  }

  // Read output storage after disposal; the caller independently decodes it.
  const sourceSnapshot = sourceBytes.slice();

  for (const item of outputs) {
    if (item.input.kind === "blob") {
      equalBytes(
        new Uint8Array(await item.input.blob.arrayBuffer()),
        sourceSnapshot,
        "Public resize changed caller Blob content.",
      );
    }

    const bytes =
      item.result.output.kind === "bytes"
        ? item.result.output.bytes
        : new Uint8Array(await item.result.output.blob.arrayBuffer());

    check(bytes instanceof Uint8Array && bytes.byteLength > 0, "Missing public resize bytes.");

    item.prepared = {
      bytes,
      metadata: item.result.metadata,
    };
  }

  return outputs;
}

export async function runBrowserResizeSmoke(
  origin,
  {
    publicAPI = false,
    compression = false,
    measureQuality = false,
    sourceWidth = 320,
    sourceHeight = 180,
  } = {},
) {
  check(
    !measureQuality || (publicAPI && compression),
    "Quality measurement requires public compression.",
  );
  check(!compression || publicAPI, "Compression acceptance requires the public API.");
  const compressionSources = new Map();
  const results = [];
  const retained = [];

  const normalTimes = measureQuality
    ? Array.from({ length: 12 }, (_, index) => Number((index / 12).toFixed(6)))
    : [0, 0.083333, 0.166667, 0.25, 0.333333, 0.416667];

  const resizeCases = [
    {
      name: "resize",
      transformations: [
        {
          type: "resize",
          options: { width: 160, height: 90 },
        },
      ],
      width: 160,
      height: 90,
      times: normalTimes,
      blobInput: false,
    },
    {
      name: "consecutive-resize",
      transformations: [
        {
          type: "resize",
          options: { width: 159, height: 89 },
        },
        {
          type: "resize",
          options: { width: 640, height: 360 },
        },
      ],
      width: 158,
      height: 88,
      times: normalTimes,
      blobInput: true,
    },
    {
      name: "trim-resize",
      transformations: [
        {
          type: "trim",
          options: { start: 0.125, end: 0.375 },
        },
        {
          type: "resize",
          options: { width: 160, height: 90 },
        },
      ],
      width: 160,
      height: 90,
      times: [0.041667, 0.125, 0.208333],
      blobInput: false,
    },
  ];

  const cases = compression
    ? [
        {
          name: "compress",
          transformations: [],
          width: sourceWidth,
          height: sourceHeight,
          times: normalTimes,
          blobInput: false,
        },
      ]
    : resizeCases;

  for (const preset of ["video-balanced-v1", "video-small-v1"]) {
    for (const hasAudio of measureQuality ? [false] : [false, true]) {
      const worker = new FFmpeg();
      const logs = [];
      let phase = "initialization";

      const context = {
        jobId: `resize-${preset}-${hasAudio}`,
        signal: new AbortController().signal,
        reportProgress() {},
      };

      worker.on("log", ({ message }) => {
        logs.push(message);
        if (logs.length > 20) logs.shift();
      });

      async function exec(args, label) {
        let diagnostic = false;

        function onLog({ type, message }) {
          const text = message.trim();

          if (type === "stderr" && text !== "" && text !== "Aborted()") {
            diagnostic = true;
          }
        }

        worker.on("log", onLog);

        try {
          const code = await worker.exec(args);

          check(
            code === 0 && !diagnostic,
            `${label} failed: exit=${code}, diagnostic=${diagnostic}.`,
          );
        } finally {
          worker.off("log", onLog);
        }
      }

      async function workspaceNames() {
        return (await worker.listDir("/"))
          .filter((entry) => entry.isDir && entry.name.startsWith("mavio-"))
          .map((entry) => entry.name)
          .sort();
      }

      try {
        await worker.load({
          classWorkerURL: new URL("/wrapper/worker.js", origin).href,
          coreURL: new URL("/core/ffmpeg-core.js", origin).href,
          wasmURL: new URL("/core/ffmpeg-core.wasm", origin).href,
        });

        const inventory = await discoverBrowserInventory(worker, context);

        const workspace = await createBrowserWorkspace(worker, context.jobId);

        phase = "fixture generation";

        const generation = [
          "-hide_banner",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=" +
            sourceWidth +
            "x" +
            sourceHeight +
            ":rate=12:duration=" +
            (measureQuality ? 1 : 0.5),
        ];

        if (hasAudio) {
          generation.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.5");
        }

        generation.push("-map", "0:v:0");

        if (hasAudio) {
          generation.push(
            "-map",
            "1:a:0",
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "1",
            "-threads:a",
            "1",
          );
        } else {
          generation.push("-an");
        }

        generation.push(
          "-t",
          measureQuality ? "1" : "0.5",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "18",
          "-pix_fmt",
          "yuv420p",
          "-threads:v",
          "1",
          "-color_primaries",
          "bt709",
          "-color_trc",
          "bt709",
          "-colorspace",
          "bt709",
          "-color_range",
          "tv",
          "-f",
          "mp4",
          workspace.inputPath,
        );

        await exec(generation, "Fixture generation");

        const sourceBytes = await worker.readFile(workspace.inputPath);

        check(sourceBytes instanceof Uint8Array, "Expected source bytes.");

        const sourceSnapshot = sourceBytes.slice();
        let sourceReference;

        if (measureQuality) {
          const referencePath = workspace.directory + "/quality-reference.yuv";
          await exec(
            [
              "-hide_banner",
              "-v",
              "error",
              "-xerror",
              "-i",
              workspace.inputPath,
              "-map",
              "0:v:0",
              "-an",
              "-sn",
              "-dn",
              "-c:v",
              "rawvideo",
              "-pix_fmt",
              "yuv420p",
              "-threads:v",
              "1",
              "-fps_mode:v",
              "passthrough",
              "-f",
              "rawvideo",
              referencePath,
            ],
            "Quality reference decoding",
          );
          sourceReference = await worker.readFile(referencePath);
        }

        if (compression) {
          if (compressionSources.has(hasAudio)) {
            equalBytes(
              sourceBytes,
              compressionSources.get(hasAudio),
              "Compression presets must use identical source bytes.",
            );
          } else {
            compressionSources.set(hasAudio, sourceSnapshot);
          }
        }

        const verificationCases = publicAPI
          ? await preparePublicResizeCases(
              origin,
              sourceBytes,
              cases,
              preset,
              compression ? "compress" : "convert",
            )
          : cases;

        equalBytes(sourceBytes, sourceSnapshot, "Public resize changed caller bytes.");

        for (const item of verificationCases) {
          phase = `${item.name}: preparation`;

          const input = item.blobInput
            ? {
                kind: "blob",
                blob: new Blob([sourceBytes], { type: "video/mp4" }),
              }
            : {
                kind: "bytes",
                bytes: sourceBytes,
              };

          const beforeWorkspaces = await workspaceNames();

          const prepared = publicAPI
            ? item.prepared
            : await prepareBrowserMp4Bytes(
                worker,
                {
                  input,
                  transformations: [
                    ...item.transformations,
                    {
                      type: "convert",
                      options: {
                        format: "mp4",
                        preset,
                      },
                    },
                  ],
                  terminal: {
                    type: "export",
                    format: "mp4",
                    preset,
                  },
                  output: { kind: "bytes" },
                },
                inventory,
                context,
              );

          check(
            JSON.stringify(await workspaceNames()) === JSON.stringify(beforeWorkspaces),
            "Preparation left a private workspace behind.",
          );

          equalBytes(sourceBytes, sourceSnapshot, "Preparation changed caller bytes.");

          if (input.kind === "blob") {
            equalBytes(
              new Uint8Array(await input.blob.arrayBuffer()),
              sourceSnapshot,
              "Preparation changed caller Blob content.",
            );
          }

          const videos = prepared.metadata.streams.filter((stream) => stream.kind === "video");

          const audios = prepared.metadata.streams.filter((stream) => stream.kind === "audio");

          check(
            videos.length === 1 &&
              videos[0].width === item.width &&
              videos[0].height === item.height,
            "Prepared dimensions differ from the resize plan.",
          );

          check(audios.length === (hasAudio ? 1 : 0), "Unexpected prepared audio stream count.");

          const outputPath = `${workspace.directory}/${item.name}.mp4`;

          const videoPath = `${workspace.directory}/${item.name}.yuv`;

          const audioPath = `${workspace.directory}/${item.name}.pcm`;

          const reportPath = `${workspace.directory}/${item.name}.json`;

          const snapshot = prepared.bytes.slice();

          await worker.writeFile(outputPath, new Uint8Array(prepared.bytes));

          phase = `${item.name}: video decoding`;

          await exec(
            [
              "-hide_banner",
              "-v",
              "error",
              "-xerror",
              "-i",
              outputPath,
              "-map",
              "0:v:0",
              "-an",
              "-sn",
              "-dn",
              "-c:v",
              "rawvideo",
              "-pix_fmt",
              "yuv420p",
              "-threads:v",
              "1",
              "-fps_mode:v",
              "passthrough",
              "-f",
              "rawvideo",
              videoPath,
            ],
            "Resized video decoding",
          );

          const video = await worker.readFile(videoPath);
          const quality = measureQuality
            ? measureLumaQuality(
                sourceReference,
                video,
                item.width,
                item.height,
                item.times.length,
                preset,
              )
            : undefined;

          check(
            video instanceof Uint8Array &&
              video.byteLength === ((item.width * item.height * 3) / 2) * item.times.length,
            "Decoded video frame count or dimensions differ.",
          );

          phase = `${item.name}: timestamp verification`;

          check(
            !(await worker.listDir(workspace.directory)).some(
              (entry) => entry.name === `${item.name}.json`,
            ),
            "Timestamp report must be fresh.",
          );

          const probeCode = await worker.ffprobe([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_streams",
            "-show_frames",
            "-show_entries",
            "stream=width,height,sample_aspect_ratio:" + "frame=best_effort_timestamp_time",
            "-of",
            "json",
            outputPath,
            "-o",
            reportPath,
          ]);

          check(probeCode === 0 || probeCode === -1, `Timestamp probing failed: ${probeCode}.`);

          const text = await worker.readFile(reportPath, "utf8");

          check(typeof text === "string", "Expected timestamp report text.");

          const report = JSON.parse(text);

          check(
            report !== null &&
              typeof report === "object" &&
              report.error === undefined &&
              Array.isArray(report.streams) &&
              report.streams.length === 1 &&
              report.streams[0].width === item.width &&
              report.streams[0].height === item.height &&
              report.streams[0].sample_aspect_ratio === "1:1" &&
              Array.isArray(report.frames) &&
              report.frames.length === item.times.length,
            "Invalid resized geometry or frame report.",
          );

          for (const [index, frame] of report.frames.entries()) {
            const timestamp = frame.best_effort_timestamp_time;

            check(
              typeof timestamp === "string" &&
                /^-?\d+(?:\.\d+)?$/.test(timestamp) &&
                Number.isFinite(Number(timestamp)) &&
                Math.abs(Number(timestamp) - item.times[index]) <= 0.0000011,
              `Unexpected frame timestamp: ${timestamp}.`,
            );
          }

          let decodedAudioSamples = 0;

          if (hasAudio) {
            phase = `${item.name}: audio decoding`;

            await exec(
              [
                "-hide_banner",
                "-v",
                "error",
                "-xerror",
                "-i",
                outputPath,
                "-map",
                "0:a:0",
                "-vn",
                "-c:a",
                "pcm_s16le",
                "-ar",
                "48000",
                "-ac",
                "1",
                "-threads:a",
                "1",
                "-f",
                "s16le",
                audioPath,
              ],
              "Resized audio decoding",
            );

            const pcm = await worker.readFile(audioPath);

            check(
              pcm instanceof Uint8Array && pcm.byteLength > 0 && pcm.byteLength % 2 === 0,
              "Expected decoded mono PCM.",
            );

            // Observe actual AAC decoding without assuming no padding.
            decodedAudioSamples = pcm.byteLength / 2;
          }

          equalBytes(prepared.bytes, snapshot, "Verification changed returned bytes.");

          retained.push({
            bytes: prepared.bytes,
            snapshot,
          });

          results.push({
            preset,
            audio: hasAudio,
            case: item.baseCase ?? item.name,
            inputKind: item.blobInput ? "blob" : "bytes",
            outputKind: item.outputKind ?? "bytes",
            route: publicAPI ? "public" : "preparation",
            width: item.width,
            height: item.height,
            videoFrames: item.times.length,
            decodedAudioSamples,
            outputBytes: prepared.bytes.byteLength,
            sourceBytes: sourceBytes.byteLength,
            operation: compression ? "compress" : "convert",
            ...(quality
              ? {
                  ...quality,
                  fixture: sourceWidth > sourceHeight ? "landscape-motion" : "portrait-motion",
                }
              : {}),
          });
        }

        phase = "fixture preservation and cleanup";

        equalBytes(
          await worker.readFile(workspace.inputPath),
          sourceSnapshot,
          "The staged source changed.",
        );

        await workspace.cleanup();

        check((await workspaceNames()).length === 0, "Resize verification left staging behind.");

        equalBytes(sourceBytes, sourceSnapshot, "Caller source changed after cleanup.");
      } catch (error) {
        throw new Error(
          `Resize smoke failed: preset=${preset}, ` +
            `audio=${hasAudio}, phase=${phase}.\n` +
            `${error instanceof Error ? error.message : String(error)}\n` +
            `Recent engine logs:\n${logs.join("\n")}`,
          { cause: error },
        );
      } finally {
        worker.terminate();
      }
    }
  }

  for (const { bytes, snapshot } of retained) {
    equalBytes(bytes, snapshot, "Returned bytes changed after worker termination.");
  }

  return results;
}
