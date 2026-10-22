import { FFmpeg } from "/wrapper/index.js";
import { discoverBrowserInventory } from "../packages/mavio/dist/engines/browser/inventory.js";
import { prepareBrowserThumbnailBytes } from "../packages/mavio/dist/engines/browser/thumbnail-bytes.js";
import { createBrowserWorkspace } from "../packages/mavio/dist/engines/browser/workspace.js";
import { createMavio } from "/mavio.mjs";

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

function context(jobId) {
  return {
    jobId,
    signal: new AbortController().signal,
    reportProgress() {},
    beginCommit() {
      throw new Error("Preparation must not publish.");
    },
  };
}

function describeError(error) {
  const lines = [];
  const seen = new Set();
  let current = error;

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);

    lines.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));

    current = current instanceof Error ? current.cause : undefined;
  }

  return lines.join("\nCaused by: ");
}

async function checkedExec(worker, args) {
  const diagnostics = [];

  function onLog({ type, message }) {
    const text = message.trim();

    if (type === "stderr" && text !== "" && text !== "Aborted()") {
      diagnostics.push(text);
      if (diagnostics.length > 12) diagnostics.shift();
    }
  }

  worker.on("log", onLog);

  try {
    const exitCode = await worker.exec(args);

    check(
      exitCode === 0 && diagnostics.length === 0,
      `Fixture encoding failed: exit=${exitCode}.\n${diagnostics.join("\n")}`,
    );
  } finally {
    worker.off("log", onLog);
  }
}

async function workspaceNames(worker) {
  return (await worker.listDir("/"))
    .filter((entry) => entry.isDir && entry.name.startsWith("mavio-"))
    .map((entry) => entry.name)
    .sort();
}

function bitmapPixels(bitmap) {
  const canvas = new globalThis.OffscreenCanvas(bitmap.width, bitmap.height);

  const drawing = canvas.getContext("2d");

  check(drawing !== null, "Could not create image comparison context.");

  drawing.drawImage(bitmap, 0, 0);

  const pixels = drawing.getImageData(0, 0, bitmap.width, bitmap.height).data;

  return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
}

export async function runBrowserThumbnailSmoke(
  origin,
  { advanced = false, publicExport = false } = {},
) {
  const retained = [];
  const results = [];

  for (const preset of ["jpeg-balanced-v1", "png-lossless-v1"]) {
    const worker = new FFmpeg();
    let client;
    const logs = [];
    let phase = "initialization";

    worker.on("log", ({ message }) => {
      logs.push(message);
      if (logs.length > 16) logs.shift();
    });

    try {
      await worker.load({
        classWorkerURL: new URL("/wrapper/worker.js", origin).href,
        coreURL: new URL("/core/ffmpeg-core.js", origin).href,
        wasmURL: new URL("/core/ffmpeg-core.wasm", origin).href,
      });

      const inventory = await discoverBrowserInventory(
        worker,
        context(`thumbnail-inventory-${preset}`),
      );

      const fixture = await createBrowserWorkspace(worker, `thumbnail-fixture-${preset}`);

      phase = "fixture generation";

      await checkedExec(worker, [
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=12:duration=0.5",
        "-an",
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
        fixture.inputPath,
      ]);

      const read = await worker.readFile(fixture.inputPath);

      check(read instanceof Uint8Array, "Expected binary source media.");

      const source = new Uint8Array(read);
      const sourceSnapshot = source.slice();
      const baseline = await workspaceNames(worker);

      const jpeg = preset === "jpeg-balanced-v1";
      const expectedWidth = advanced ? 158 : 160;
      const expectedHeight = advanced ? (jpeg ? 88 : 89) : 90;
      let referenceBytes;

      if (advanced) {
        phase = "independent reference encoding";

        const referencePath = `${fixture.directory}/reference.${jpeg ? "jpeg" : "png"}`;

        const conversion = jpeg
          ? "scale=in_color_matrix=bt709:out_color_matrix=bt601:in_range=tv:out_range=pc,format=yuvj420p"
          : "scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24";

        const resize = `scale=w=${expectedWidth}:h=${expectedHeight}:flags=lanczos,setsar=1`;

        // At 12 fps, the first frame at/after 0.125 seconds is
        // zero-based frame 2. Select it by index independently of trim planning.
        await checkedExec(worker, [
          "-hide_banner",
          "-v",
          "error",
          "-xerror",
          "-noautorotate",
          "-filter_threads",
          "1",
          "-i",
          fixture.inputPath,
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
          ["select=eq(n\\,2)", "setpts=PTS-STARTPTS", conversion, resize, resize].join(","),
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
          "-c:v",
          jpeg ? "mjpeg" : "png",
          ...(jpeg
            ? ["-q:v", "3", "-pix_fmt", "yuvj420p"]
            : ["-pix_fmt", "rgb24", "-compression_level", "6"]),
          "-frames:v",
          "1",
          "-threads:v",
          "1",
          "-f",
          "image2pipe",
          referencePath,
        ]);

        const reference = await worker.readFile(referencePath);

        check(reference instanceof Uint8Array, "Expected binary reference image.");

        referenceBytes = new Uint8Array(reference);
      }

      if (publicExport) {
        client = createMavio({
          initTimeoutMs: 60000,
          browser: {
            assets: {
              coreURL: new URL("/core/ffmpeg-core.js", origin).href,
              wasmURL: new URL("/core/ffmpeg-core.wasm", origin).href,
              classWorkerURL: new URL("/wrapper/worker.js", origin).href,
            },
          },
        });
      }

      async function prepareCase(inputKind, outputKind, caseName) {
        phase = `${caseName}/${inputKind}/${outputKind}`;

        const blob = new Blob([source], { type: "video/mp4" });

        const plan = {
          input: inputKind === "bytes" ? { kind: "bytes", bytes: source } : { kind: "blob", blob },
          transformations: advanced
            ? [
                ...(inputKind === "blob"
                  ? [
                      {
                        type: "trim",
                        options: { start: 0.03125, end: 0.46875 },
                      },
                      {
                        type: "trim",
                        options: { start: 0.03125, end: 0.34375 },
                      },
                    ]
                  : []),
                {
                  type: "resize",
                  options: { width: 159, height: 89 },
                },
                {
                  type: "resize",
                  options: { width: 640, height: 360 },
                },
              ]
            : [],
          terminal: {
            type: "thumbnail",
            at: advanced && inputKind === "blob" ? 0.0625 : 0.125,
            format: preset === "jpeg-balanced-v1" ? "jpeg" : "png",
            preset,
          },
          output: { kind: "bytes" },
        };

        let prepared;
        let publicOutput;

        if (publicExport) {
          let pipeline = client.from(plan.input);

          for (const operation of plan.transformations) {
            if (operation.type === "trim") {
              pipeline = pipeline.trim(operation.options);
            } else {
              pipeline = pipeline.resize(operation.options);
            }
          }

          const result = await pipeline.thumbnail({
            at: plan.terminal.at,
            format: plan.terminal.format,
            preset,
            output: { kind: outputKind },
          });

          check(
            result.engine.id === "browser-ffmpeg" && result.output.kind === outputKind,
            "Unexpected public thumbnail engine or output kind.",
          );

          publicOutput = result.output;

          const mime = preset === "jpeg-balanced-v1" ? "image/jpeg" : "image/png";

          if (outputKind === "blob") {
            check(publicOutput.blob.type === mime, "Public thumbnail Blob MIME type is incorrect.");
          }

          prepared = {
            bytes:
              outputKind === "bytes"
                ? publicOutput.bytes
                : new Uint8Array(await publicOutput.blob.arrayBuffer()),
            metadata: result.metadata,
          };
        } else {
          prepared = await prepareBrowserThumbnailBytes(
            worker,
            plan,
            inventory,
            context(`thumbnail-${preset}-${inputKind}`),
          );
        }

        const image = prepared.metadata.streams[0];

        check(
          prepared.metadata.streams.length === 1 &&
            image.kind === "video" &&
            image.codec === (preset === "jpeg-balanced-v1" ? "mjpeg" : "png") &&
            image.width === expectedWidth &&
            image.height === expectedHeight,
          "Prepared thumbnail metadata is incorrect.",
        );

        check(
          prepared.bytes.length > 0 && prepared.metadata.sizeBytes === prepared.bytes.length,
          "Prepared thumbnail size is incorrect.",
        );

        check(
          JSON.stringify(await workspaceNames(worker)) === JSON.stringify(baseline),
          "Thumbnail preparation changed fixture workspace ownership.",
        );

        equalBytes(source, sourceSnapshot, "Caller source bytes changed.");

        equalBytes(
          new Uint8Array(await blob.arrayBuffer()),
          sourceSnapshot,
          "Caller Blob content changed.",
        );

        retained.push({
          preset,
          inputKind,
          outputKind,
          case: caseName,
          publicOutput,
          bytes: prepared.bytes,
          snapshot: prepared.bytes.slice(),
          expectedWidth,
          expectedHeight,
          referenceBytes,
        });
      }

      for (const inputKind of ["bytes", "blob"]) {
        for (const outputKind of publicExport ? ["bytes", "blob"] : ["bytes"]) {
          await prepareCase(inputKind, outputKind, "matrix");
        }
      }

      if (publicExport) {
        phase = "empty thumbnail selection rejection";
        let emptyFailure;

        try {
          // The final fixture frame is at 5/12 seconds.
          // No frame exists in [0.49, 0.5).
          await client.from({ kind: "bytes", bytes: source }).thumbnail({
            at: 0.49,
            format: preset === "jpeg-balanced-v1" ? "jpeg" : "png",
            preset,
            output: { kind: "bytes" },
          });
        } catch (error) {
          emptyFailure = error;
        }

        check(
          emptyFailure?.code === "INVALID_OPTIONS" &&
            emptyFailure?.details?.reason === "RANGE_TOO_SHORT" &&
            emptyFailure?.details?.streamKind === "video",
          "Empty thumbnail selection did not reject correctly.",
        );

        // Reuse the same public client after its rejected job.
        await prepareCase("bytes", "bytes", "after-empty");
      }

      equalBytes(
        await worker.readFile(fixture.inputPath),
        sourceSnapshot,
        "The original staged fixture changed.",
      );

      await fixture.cleanup();

      check((await workspaceNames(worker)).length === 0, "Thumbnail smoke left staging behind.");
    } catch (error) {
      throw new Error(
        `Thumbnail smoke failed: preset=${preset}, phase=${phase}.\n` +
          `${describeError(error)}\nRecent engine logs:\n${logs.join("\n")}`,
        { cause: error },
      );
    } finally {
      try {
        await client?.dispose();
      } finally {
        worker.terminate();
      }
    }
  }

  // Decode with Chromium after both preparation workers terminate.
  for (const item of retained) {
    equalBytes(
      item.bytes,
      item.snapshot,
      "Returned thumbnail bytes changed after worker termination.",
    );

    const mime = item.preset === "jpeg-balanced-v1" ? "image/jpeg" : "image/png";

    const bitmap = await globalThis.createImageBitmap(new Blob([item.bytes], { type: mime }));

    try {
      check(
        bitmap.width === item.expectedWidth && bitmap.height === item.expectedHeight,
        "Chromium decoded unexpected thumbnail dimensions.",
      );

      if (item.publicOutput !== undefined) {
        const current =
          item.publicOutput.kind === "bytes"
            ? item.publicOutput.bytes
            : new Uint8Array(await item.publicOutput.blob.arrayBuffer());

        equalBytes(
          current,
          item.snapshot,
          "Public thumbnail output changed after client disposal.",
        );
      }

      if (item.referenceBytes !== undefined) {
        const reference = await globalThis.createImageBitmap(
          new Blob([item.referenceBytes], { type: mime }),
        );

        try {
          check(
            reference.width === bitmap.width && reference.height === bitmap.height,
            "Independent reference dimensions differ.",
          );

          equalBytes(
            bitmapPixels(bitmap),
            bitmapPixels(reference),
            "Thumbnail pixels differ from independently selected source frame 2.",
          );
        } finally {
          reference.close();
        }
      }

      results.push({
        preset: item.preset,
        inputKind: item.inputKind,
        outputBytes: item.bytes.length,
        width: bitmap.width,
        height: bitmap.height,
        referenceMatched: item.referenceBytes !== undefined,
        outputKind: item.outputKind,
        case: item.case,
      });
    } finally {
      bitmap.close();
    }

    equalBytes(item.bytes, item.snapshot, "Image decoding changed returned thumbnail bytes.");
  }

  return results;
}
