import { FFmpeg } from "/wrapper/index.js";
import { discoverBrowserInventory } from "../packages/mavio/dist/engines/browser/inventory.js";
import { prepareBrowserAudioBytes } from "../packages/mavio/dist/engines/browser/audio-bytes.js";
import { createBrowserWorkspace } from "../packages/mavio/dist/engines/browser/workspace.js";
import { createMavio } from "/mavio.mjs";
import { buildBrowserAudioTrimPlan } from "../packages/mavio/dist/engines/browser/audio-trim-plan.js";
import { analyzeBrowserAudioTrim } from "../packages/mavio/dist/engines/browser/audio-trim-analysis.js";
import { parseBrowserProbeDetails } from "../packages/mavio/dist/engines/browser/probe-details.js";

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

function makeSource() {
  const sampleRate = 48000;
  const samples = 12000;
  const channels = 2;
  const bytes = new Uint8Array(44 + samples * channels * 2);
  const view = new DataView(bytes.buffer);

  function text(offset, value) {
    bytes.set(new TextEncoder().encode(value), offset);
  }

  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, bytes.length - 44, true);

  for (let sample = 0; sample < samples; sample += 1) {
    const time = sample / sampleRate;

    view.setInt16(44 + sample * 4, Math.round(Math.sin(2 * Math.PI * 440 * time) * 12000), true);

    view.setInt16(46 + sample * 4, Math.round(Math.sin(2 * Math.PI * 660 * time) * 10000), true);
  }

  return bytes;
}

function context(jobId) {
  return {
    jobId,
    signal: new AbortController().signal,
    reportProgress() {},
    beginCommit() {
      throw new Error("Internal preparation must not publish.");
    },
  };
}

async function load(worker, origin) {
  await worker.load({
    classWorkerURL: new URL("/wrapper/worker.js", origin).href,
    coreURL: new URL("/core/ffmpeg-core.js", origin).href,
    wasmURL: new URL("/core/ffmpeg-core.wasm", origin).href,
  });
}

async function assertNoWorkspaces(worker) {
  const entries = await worker.listDir("/");

  check(
    !entries.some((entry) => entry.isDir && entry.name.startsWith("mavio-")),
    "Audio preparation left a workspace behind.",
  );
}

function describeError(error) {
  const messages = [];
  const seen = new Set();
  let current = error;

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    messages.push(
      current instanceof Error ? `${current.name}: ${current.message}` : String(current),
    );
    current = current instanceof Error ? current.cause : undefined;
  }

  return messages.join("\nCaused by: ");
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
      `Audio decoding failed: exit=${exitCode}.\n${diagnostics.join("\n")}`,
    );
  } finally {
    worker.off("log", onLog);
  }
}

export async function runBrowserAudioSmoke(origin) {
  const source = makeSource();
  const sourceSnapshot = source.slice();
  const retained = [];
  const results = [];

  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    const worker = new FFmpeg();
    const logs = [];
    let phase = "initialization";

    worker.on("log", ({ message }) => {
      logs.push(message);
      if (logs.length > 16) logs.shift();
    });

    try {
      await load(worker, origin);

      const inventory = await discoverBrowserInventory(
        worker,
        context(`audio-inventory-${preset}`),
      );

      for (const inputKind of ["bytes", "blob"]) {
        phase = `${inputKind} preparation`;

        const blob = new Blob([source], { type: "audio/wav" });

        const plan = {
          input: inputKind === "bytes" ? { kind: "bytes", bytes: source } : { kind: "blob", blob },
          transformations: [],
          terminal: {
            type: "export",
            format: preset === "audio-balanced-v1" ? "mp3" : "wav",
            preset,
          },
          output: { kind: "bytes" },
        };

        const prepared = await prepareBrowserAudioBytes(
          worker,
          plan,
          inventory,
          context(`audio-${preset}-${inputKind}`),
        );

        check(prepared.bytes.length > 0, "Audio output was empty.");
        check(prepared.metadata.streams.length === 1, "Expected exactly one output stream.");

        const audio = prepared.metadata.streams[0];

        check(
          audio.kind === "audio" &&
            audio.sampleRate === 48000 &&
            audio.channels === 2 &&
            audio.codec === (preset === "audio-balanced-v1" ? "mp3" : "pcm_s16le"),
          "Prepared audio metadata does not match the source profile.",
        );

        await assertNoWorkspaces(worker);

        equalBytes(source, sourceSnapshot, "Caller source bytes changed.");

        if (inputKind === "blob") {
          equalBytes(
            new Uint8Array(await blob.arrayBuffer()),
            sourceSnapshot,
            "Caller Blob content changed.",
          );
        }

        retained.push({
          preset,
          inputKind,
          bytes: prepared.bytes,
          snapshot: prepared.bytes.slice(),
        });
      }
    } catch (error) {
      throw new Error(
        `Audio smoke failed: preset=${preset}, phase=${phase}.\n` +
          `${describeError(error)}\nRecent engine logs:\n${logs.join("\n")}`,
        { cause: error },
      );
    } finally {
      worker.terminate();
    }
  }

  // Decode only after both preparation workers have terminated.
  const verifier = new FFmpeg();
  let phase = "verification initialization";

  try {
    await load(verifier, origin);

    for (const item of retained) {
      phase = `${item.preset}/${item.inputKind} decoding`;

      equalBytes(
        item.bytes,
        item.snapshot,
        "Returned audio bytes changed after worker termination.",
      );

      const workspace = await createBrowserWorkspace(
        verifier,
        `verify-${item.preset}-${item.inputKind}`,
      );

      const pcmPath = `${workspace.directory}/decoded.pcm`;

      // writeFile may transfer its buffer; preserve the returned output.
      await verifier.writeFile(workspace.inputPath, new Uint8Array(item.bytes));

      await checkedExec(verifier, [
        "-hide_banner",
        "-v",
        "error",
        "-xerror",
        "-i",
        workspace.inputPath,
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-c:a",
        "pcm_s16le",
        "-threads:a",
        "1",
        "-f",
        "s16le",
        pcmPath,
      ]);

      const decoded = await verifier.readFile(pcmPath);

      check(
        decoded instanceof Uint8Array && decoded.length > 0 && decoded.length % 4 === 0,
        "Expected nonempty stereo 16-bit decoded audio.",
      );

      const decodedSamples = decoded.length / 4;

      if (item.preset === "audio-pcm-v1") {
        check(decodedSamples === 12000, "PCM output changed the source sample count.");

        equalBytes(
          decoded,
          sourceSnapshot.subarray(44),
          "Decoded PCM differs from the original source samples.",
        );
      }

      // MP3 is lossy; observe its decoded count without assuming no padding.
      equalBytes(item.bytes, item.snapshot, "Verification changed returned audio bytes.");

      await workspace.cleanup();
      await assertNoWorkspaces(verifier);

      results.push({
        preset: item.preset,
        inputKind: item.inputKind,
        outputBytes: item.bytes.length,
        decodedSamples,
      });
    }
  } catch (error) {
    throw new Error(`Audio smoke failed during ${phase}.\n${describeError(error)}`, {
      cause: error,
    });
  } finally {
    verifier.terminate();
  }

  equalBytes(source, sourceSnapshot, "Source changed after verification.");

  for (const item of retained) {
    equalBytes(
      item.bytes,
      item.snapshot,
      "Returned output changed after verification worker termination.",
    );
  }

  return results;
}

export async function runPublicBrowserAudioSmoke(origin) {
  const source = makeSource();
  const sourceSnapshot = source.slice();
  const retained = [];
  const results = [];

  async function outputBytes(output) {
    return output.kind === "bytes" ? output.bytes : new Uint8Array(await output.blob.arrayBuffer());
  }

  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    const format = preset === "audio-balanced-v1" ? "mp3" : "wav";
    const mime = format === "mp3" ? "audio/mpeg" : "audio/wav";
    let phase = "client creation";

    const client = createMavio({
      initTimeoutMs: 60000,
      browser: {
        assets: {
          coreURL: new URL("/core/ffmpeg-core.js", origin).href,
          wasmURL: new URL("/core/ffmpeg-core.wasm", origin).href,
          classWorkerURL: new URL("/wrapper/worker.js", origin).href,
        },
      },
    });

    try {
      for (const inputKind of ["bytes", "blob"]) {
        const blob = new Blob([source], { type: "audio/wav" });

        for (const outputKind of ["bytes", "blob"]) {
          for (const operation of ["convert", "compress"]) {
            phase = `${inputKind}/${outputKind}/${operation}`;

            const input =
              inputKind === "bytes" ? { kind: "bytes", bytes: source } : { kind: "blob", blob };

            const pipeline = client.from(input);

            const transformed =
              operation === "convert"
                ? pipeline.convert({ format, preset })
                : pipeline.compress({ preset });

            const result = await transformed.export({
              format,
              output: { kind: outputKind },
            });

            check(result.engine.id === "browser-ffmpeg", "Expected the public browser engine.");

            check(result.output.kind === outputKind, "Public audio output kind changed.");

            const audio = result.metadata.streams[0];

            check(
              result.metadata.container === format &&
                result.metadata.streams.length === 1 &&
                audio.kind === "audio" &&
                audio.codec === (format === "mp3" ? "mp3" : "pcm_s16le") &&
                audio.sampleRate === 48000 &&
                audio.channels === 2,
              "Public audio metadata does not match the requested profile.",
            );

            if (outputKind === "blob") {
              check(result.output.blob.type === mime, "Public audio Blob MIME type is incorrect.");
            }

            const bytes = await outputBytes(result.output);

            check(
              bytes.length > 0 && result.metadata.sizeBytes === bytes.length,
              "Public audio output size does not match its metadata.",
            );

            retained.push({
              preset,
              inputKind,
              outputKind,
              operation,
              output: result.output,
              snapshot: new Uint8Array(bytes),
            });

            equalBytes(source, sourceSnapshot, "Public export changed caller source bytes.");

            equalBytes(
              new Uint8Array(await blob.arrayBuffer()),
              sourceSnapshot,
              "Public export changed caller Blob content.",
            );
          }
        }
      }

      async function extraction(input, streamIndex) {
        const pipeline = client.from(input);

        const selected =
          streamIndex === undefined
            ? pipeline.extractAudio()
            : pipeline.extractAudio({ streamIndex });

        return selected.convert({ format, preset }).export({
          format,
          output: { kind: "bytes" },
        });
      }

      async function retainExtraction(operation, streamIndex) {
        phase = operation;

        const result = await extraction({ kind: "bytes", bytes: source }, streamIndex);

        const audio = result.metadata.streams[0];

        check(
          result.output.kind === "bytes" &&
            result.engine.id === "browser-ffmpeg" &&
            result.metadata.container === format &&
            result.metadata.streams.length === 1 &&
            audio.kind === "audio" &&
            audio.codec === (format === "mp3" ? "mp3" : "pcm_s16le") &&
            audio.sampleRate === 48000 &&
            audio.channels === 2 &&
            result.metadata.sizeBytes === result.output.bytes.length &&
            result.output.bytes.length > 0,
          `Invalid public extraction result during ${operation}.`,
        );

        retained.push({
          preset,
          inputKind: "bytes",
          outputKind: "bytes",
          operation,
          output: result.output,
          snapshot: new Uint8Array(result.output.bytes),
        });

        equalBytes(source, sourceSnapshot, `Source changed during ${operation}.`);
      }

      await retainExtraction("extract-default");
      await retainExtraction("extract-explicit", 0);

      phase = "invalid-stream rejection";

      let streamFailure;

      try {
        await extraction({ kind: "bytes", bytes: source }, 99);
      } catch (error) {
        streamFailure = error;
      }

      check(
        streamFailure?.code === "INVALID_OPTIONS" &&
          streamFailure?.details?.reason === "INVALID_STREAM_INDEX",
        "An absent audio stream must reject with INVALID_STREAM_INDEX.",
      );

      // Reuse the same public client after rejection.
      await retainExtraction("recover-invalid-stream", 0);

      phase = "invalid-media rejection";

      const invalidBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const invalidSnapshot = invalidBytes.slice();
      let mediaFailure;

      try {
        await extraction({ kind: "bytes", bytes: invalidBytes }, undefined);
      } catch (error) {
        mediaFailure = error;
      }

      check(
        mediaFailure?.code === "INVALID_MEDIA",
        "Invalid audio content must reject with INVALID_MEDIA.",
      );

      equalBytes(invalidBytes, invalidSnapshot, "Rejected media bytes changed or became detached.");

      await retainExtraction("recover-invalid-media");
    } catch (error) {
      throw new Error(
        `Public audio export failed: preset=${preset}, phase=${phase}.\n` + describeError(error),
        { cause: error },
      );
    } finally {
      await client.dispose();
    }
  }

  // Both public clients are disposed before verification begins.
  const verifier = new FFmpeg();
  let phase = "verification initialization";

  try {
    await load(verifier, origin);

    for (const item of retained) {
      phase = `${item.preset}/${item.inputKind}/` + `${item.outputKind}/${item.operation}`;

      const bytes = await outputBytes(item.output);

      equalBytes(bytes, item.snapshot, "Public audio output changed after client disposal.");

      const workspace = await createBrowserWorkspace(verifier, `public-audio-${results.length}`);

      const pcmPath = `${workspace.directory}/decoded.pcm`;

      await verifier.writeFile(workspace.inputPath, new Uint8Array(bytes));

      await checkedExec(verifier, [
        "-hide_banner",
        "-v",
        "error",
        "-xerror",
        "-i",
        workspace.inputPath,
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-c:a",
        "pcm_s16le",
        "-threads:a",
        "1",
        "-f",
        "s16le",
        pcmPath,
      ]);

      const decoded = await verifier.readFile(pcmPath);

      check(
        decoded instanceof Uint8Array && decoded.length > 0 && decoded.length % 4 === 0,
        "Public audio output did not decode to stereo PCM.",
      );

      const decodedSamples = decoded.length / 4;

      if (item.preset === "audio-pcm-v1") {
        check(decodedSamples === 12000, "Public PCM output changed the source sample count.");

        equalBytes(
          decoded,
          sourceSnapshot.subarray(44),
          "Public PCM output changed the source samples.",
        );
      }

      await workspace.cleanup();
      await assertNoWorkspaces(verifier);

      equalBytes(
        await outputBytes(item.output),
        item.snapshot,
        "Decoding changed the retained public output.",
      );

      results.push({
        preset: item.preset,
        inputKind: item.inputKind,
        outputKind: item.outputKind,
        operation: item.operation,
        outputBytes: bytes.length,
        decodedSamples,
      });
    }
  } catch (error) {
    throw new Error(`Public audio verification failed during ${phase}.\n` + describeError(error), {
      cause: error,
    });
  } finally {
    verifier.terminate();
  }

  equalBytes(source, sourceSnapshot, "Public audio verification changed caller source bytes.");

  for (const item of retained) {
    equalBytes(
      await outputBytes(item.output),
      item.snapshot,
      "Public audio output changed after verifier termination.",
    );
  }

  return results;
}

export async function runBrowserAudioTrimAnalysisSmoke(origin) {
  const worker = new FFmpeg();
  const source = makeSource();
  const snapshot = source.slice();
  const logs = [];
  let phase = "initialization";

  worker.on("log", ({ message }) => {
    logs.push(message);
    if (logs.length > 16) logs.shift();
  });

  try {
    await load(worker, origin);

    const execution = context("browser-audio-trim-analysis-smoke");
    const inventory = await discoverBrowserInventory(worker, execution);
    const workspace = await createBrowserWorkspace(worker, execution.jobId);

    phase = "source staging and probing";

    await worker.writeFile(workspace.inputPath, new Uint8Array(source));

    const exitCode = await worker.ffprobe([
      "-v",
      "error",
      "-show_error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      workspace.inputPath,
      "-o",
      workspace.probePath,
    ]);

    const text = await worker.readFile(workspace.probePath, "utf8");

    check(typeof text === "string", "Expected a text probe report.");

    const details = parseBrowserProbeDetails(text, exitCode, execution.jobId);

    await worker.deleteFile(workspace.probePath);

    const audio = details.metadata.streams.find((stream) => stream.kind === "audio");

    check(
      audio !== undefined &&
        audio.codec === "pcm_s16le" &&
        audio.sampleRate === 48000 &&
        audio.channels === 2,
      "Unexpected audio trim fixture profile.",
    );

    function trim(start, end) {
      return { type: "trim", options: { start, end } };
    }

    async function analyze(transformations) {
      const filters = buildBrowserAudioTrimPlan(
        transformations,
        details.metadata.durationSeconds,
        // The generated PCM WAV fixture starts at zero.
        details.formatStartTimeSeconds ?? 0,
        inventory,
      );

      check(filters !== undefined, "Expected a trim plan.");

      return analyzeBrowserAudioTrim(
        worker,
        {
          inputPath: workspace.inputPath,
          streamIndex: audio.index,
          channels: audio.channels,
          filters,
          inventory,
        },
        execution,
      );
    }

    phase = "fractional trim analysis";

    const fractional = await analyze([trim(0.0625, 0.1875)]);

    check(
      fractional.audioSamples === 6000,
      "Fractional audio trim must select 6000 samples per channel.",
    );

    phase = "consecutive trim analysis";

    const consecutive = await analyze([trim(0.03125, 0.21875), trim(0.03125, 0.15625)]);

    check(
      consecutive.audioSamples === 6000,
      "Consecutive trims must select the same 6000 source samples.",
    );

    phase = "empty selection rejection";

    let emptyFailure;

    try {
      await analyze([trim(0.000001, 0.000002)]);
    } catch (error) {
      emptyFailure = error;
    }

    check(
      emptyFailure?.code === "INVALID_OPTIONS" &&
        emptyFailure?.details?.reason === "RANGE_TOO_SHORT" &&
        emptyFailure?.details?.streamKind === "audio",
      "An interval with no selected audio samples must reject.",
    );

    check(worker.loaded, "Empty selection unexpectedly terminated the worker.");

    phase = "same-worker recovery";

    const recovered = await analyze([trim(0.0625, 0.1875)]);

    check(recovered.audioSamples === 6000, "Audio analysis did not recover after empty selection.");

    equalBytes(
      await worker.readFile(workspace.inputPath),
      snapshot,
      "Trim analysis changed the staged source.",
    );

    const entries = await worker.listDir(workspace.directory);

    check(
      entries
        .filter((entry) => entry.name !== "." && entry.name !== "..")
        .every((entry) => !entry.isDir && entry.name === "input.bin"),
      "Trim analysis left unexpected files in the workspace.",
    );

    await workspace.cleanup();
    await assertNoWorkspaces(worker);

    equalBytes(source, snapshot, "Trim analysis changed caller bytes.");

    return {
      fractionalSamples: fractional.audioSamples,
      consecutiveSamples: consecutive.audioSamples,
      recoveredSamples: recovered.audioSamples,
      emptyCode: emptyFailure.code,
    };
  } catch (error) {
    throw new Error(
      `Browser audio trim analysis smoke failed during ${phase}.\n` +
        `${describeError(error)}\nRecent engine logs:\n${logs.join("\n")}`,
      { cause: error },
    );
  } finally {
    worker.terminate();
  }
}

export async function runBrowserAudioTrimPreparationSmoke(origin) {
  const source = makeSource();
  const sourceSnapshot = source.slice();

  // At 48 kHz, [0.0625, 0.1875) selects samples [3000, 9000).
  const expectedPCM = sourceSnapshot.subarray(44 + 3000 * 4, 44 + 9000 * 4);

  const retained = [];
  const results = [];

  function trim(start, end) {
    return { type: "trim", options: { start, end } };
  }

  const cases = [
    {
      name: "fractional-bytes",
      inputKind: "bytes",
      transformations: [trim(0.0625, 0.1875)],
    },
    {
      name: "consecutive-blob",
      inputKind: "blob",
      transformations: [trim(0.03125, 0.21875), trim(0.03125, 0.15625)],
    },
  ];

  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    const worker = new FFmpeg();
    const logs = [];
    let phase = "initialization";

    worker.on("log", ({ message }) => {
      logs.push(message);
      if (logs.length > 16) logs.shift();
    });

    try {
      await load(worker, origin);

      const inventory = await discoverBrowserInventory(worker, context(`trim-inventory-${preset}`));

      for (const item of cases) {
        phase = item.name;

        const blob = new Blob([source], { type: "audio/wav" });

        const plan = {
          input:
            item.inputKind === "bytes" ? { kind: "bytes", bytes: source } : { kind: "blob", blob },
          transformations: item.transformations,
          terminal: {
            type: "export",
            format: preset === "audio-balanced-v1" ? "mp3" : "wav",
            preset,
          },
          output: { kind: "bytes" },
        };

        const prepared = await prepareBrowserAudioBytes(
          worker,
          plan,
          inventory,
          context(`trim-${preset}-${item.name}`),
        );

        const audio = prepared.metadata.streams[0];

        check(
          prepared.metadata.streams.length === 1 &&
            audio.kind === "audio" &&
            audio.codec === (preset === "audio-balanced-v1" ? "mp3" : "pcm_s16le") &&
            audio.sampleRate === 48000 &&
            audio.channels === 2,
          "Trimmed output has an unexpected audio profile.",
        );

        check(
          prepared.bytes.length > 0 && prepared.metadata.sizeBytes === prepared.bytes.length,
          "Trimmed output size is invalid.",
        );

        await assertNoWorkspaces(worker);

        equalBytes(source, sourceSnapshot, "Trim preparation changed caller bytes.");

        equalBytes(
          new Uint8Array(await blob.arrayBuffer()),
          sourceSnapshot,
          "Trim preparation changed caller Blob content.",
        );

        retained.push({
          preset,
          case: item.name,
          bytes: prepared.bytes,
          snapshot: prepared.bytes.slice(),
        });
      }
    } catch (error) {
      throw new Error(
        `Trim preparation failed: preset=${preset}, phase=${phase}.\n` +
          `${describeError(error)}\nRecent engine logs:\n${logs.join("\n")}`,
        { cause: error },
      );
    } finally {
      worker.terminate();
    }
  }

  // Decode retained output only after both preparation workers terminate.
  const verifier = new FFmpeg();
  let phase = "verification initialization";

  try {
    await load(verifier, origin);

    for (const item of retained) {
      phase = `${item.preset}/${item.case}`;

      equalBytes(
        item.bytes,
        item.snapshot,
        "Trimmed bytes changed after preparation worker termination.",
      );

      const workspace = await createBrowserWorkspace(verifier, `verify-trim-${results.length}`);

      const pcmPath = `${workspace.directory}/decoded.pcm`;

      await verifier.writeFile(workspace.inputPath, new Uint8Array(item.bytes));

      await checkedExec(verifier, [
        "-hide_banner",
        "-v",
        "error",
        "-xerror",
        "-i",
        workspace.inputPath,
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-c:a",
        "pcm_s16le",
        "-threads:a",
        "1",
        "-f",
        "s16le",
        pcmPath,
      ]);

      const decoded = await verifier.readFile(pcmPath);

      check(
        decoded instanceof Uint8Array && decoded.length > 0 && decoded.length % 4 === 0,
        "Trimmed output did not decode to stereo PCM.",
      );

      const decodedSamples = decoded.length / 4;

      if (item.preset === "audio-pcm-v1") {
        check(decodedSamples === 6000, "Trimmed PCM must contain 6000 samples per channel.");

        equalBytes(decoded, expectedPCM, "Trimmed PCM differs from the requested source samples.");
      }

      await workspace.cleanup();
      await assertNoWorkspaces(verifier);

      equalBytes(item.bytes, item.snapshot, "Verification changed returned trimmed bytes.");

      results.push({
        preset: item.preset,
        case: item.case,
        selectedSamples: 6000,
        decodedSamples,
        outputBytes: item.bytes.length,
      });
    }
  } catch (error) {
    throw new Error(`Trimmed audio verification failed during ${phase}.\n` + describeError(error), {
      cause: error,
    });
  } finally {
    verifier.terminate();
  }

  equalBytes(source, sourceSnapshot, "Caller source changed.");

  for (const item of retained) {
    equalBytes(
      item.bytes,
      item.snapshot,
      "Trimmed bytes changed after verification worker termination.",
    );
  }

  return results;
}
export async function runPublicBrowserAudioTrimSmoke(origin) {
  const source = makeSource();
  const sourceSnapshot = source.slice();
  const expectedPCM = sourceSnapshot.subarray(44 + 3000 * 4, 44 + 9000 * 4);

  const retained = [];
  const results = [];

  async function readOutput(output) {
    return output.kind === "bytes" ? output.bytes : new Uint8Array(await output.blob.arrayBuffer());
  }

  for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
    const format = preset === "audio-balanced-v1" ? "mp3" : "wav";
    const mime = format === "mp3" ? "audio/mpeg" : "audio/wav";
    let phase = "client initialization";

    const client = createMavio({
      initTimeoutMs: 60000,
      browser: {
        assets: {
          coreURL: new URL("/core/ffmpeg-core.js", origin).href,
          wasmURL: new URL("/core/ffmpeg-core.wasm", origin).href,
          classWorkerURL: new URL("/wrapper/worker.js", origin).href,
        },
      },
    });

    async function exportTrim(inputKind, outputKind, name) {
      phase = `${name}/${inputKind}/${outputKind}`;

      const blob = new Blob([source], { type: "audio/wav" });

      const input =
        inputKind === "bytes" ? { kind: "bytes", bytes: source } : { kind: "blob", blob };

      let pipeline = client.from(input).extractAudio({
        streamIndex: 0,
      });

      if (inputKind === "blob") {
        pipeline = pipeline
          .trim({ start: 0.03125, end: 0.21875 })
          .trim({ start: 0.03125, end: 0.15625 });
      } else {
        pipeline = pipeline.trim({
          start: 0.0625,
          end: 0.1875,
        });
      }

      const result = await pipeline.convert({ format, preset }).export({
        format,
        output: { kind: outputKind },
      });

      const audio = result.metadata.streams[0];

      check(
        result.engine.id === "browser-ffmpeg" &&
          result.output.kind === outputKind &&
          result.metadata.container === format &&
          result.metadata.streams.length === 1 &&
          audio.kind === "audio" &&
          audio.codec === (format === "mp3" ? "mp3" : "pcm_s16le") &&
          audio.sampleRate === 48000 &&
          audio.channels === 2,
        "Public trimmed output has an unexpected profile.",
      );

      if (outputKind === "blob") {
        check(result.output.blob.type === mime, "Public trimmed Blob has the wrong MIME type.");
      }

      const bytes = await readOutput(result.output);

      check(
        bytes.length > 0 && result.metadata.sizeBytes === bytes.length,
        "Public trimmed output has an invalid size.",
      );

      retained.push({
        preset,
        inputKind,
        outputKind,
        case: name,
        output: result.output,
        snapshot: new Uint8Array(bytes),
      });

      equalBytes(source, sourceSnapshot, "Caller source bytes changed.");

      equalBytes(
        new Uint8Array(await blob.arrayBuffer()),
        sourceSnapshot,
        "Caller Blob content changed.",
      );
    }

    try {
      for (const inputKind of ["bytes", "blob"]) {
        for (const outputKind of ["bytes", "blob"]) {
          await exportTrim(
            inputKind,
            outputKind,
            inputKind === "bytes" ? "fractional" : "consecutive",
          );
        }
      }

      phase = "empty trim rejection";
      let emptyFailure;

      try {
        await client
          .from({ kind: "bytes", bytes: source })
          .trim({ start: 0.000001, end: 0.000002 })
          .convert({ format, preset })
          .export({
            format,
            output: { kind: "bytes" },
          });
      } catch (error) {
        emptyFailure = error;
      }

      check(
        emptyFailure?.code === "INVALID_OPTIONS" &&
          emptyFailure?.details?.reason === "RANGE_TOO_SHORT" &&
          emptyFailure?.details?.streamKind === "audio",
        "Empty public audio trim did not reject correctly.",
      );

      // Reuse the same public client after its failed job.
      await exportTrim("bytes", "bytes", "after-empty");

      equalBytes(source, sourceSnapshot, "Empty trim or recovery changed caller bytes.");
    } catch (error) {
      throw new Error(
        `Public audio trim failed: preset=${preset}, phase=${phase}.\n` + describeError(error),
        { cause: error },
      );
    } finally {
      await client.dispose();
    }
  }

  // Both clients are disposed before decoding retained outputs.
  const verifier = new FFmpeg();
  let phase = "verification initialization";

  try {
    await load(verifier, origin);

    for (const item of retained) {
      phase = `${item.preset}/${item.case}/` + `${item.inputKind}/${item.outputKind}`;

      const bytes = await readOutput(item.output);

      equalBytes(bytes, item.snapshot, "Public trimmed output changed after client disposal.");

      const workspace = await createBrowserWorkspace(
        verifier,
        `public-audio-trim-${results.length}`,
      );

      const pcmPath = `${workspace.directory}/decoded.pcm`;

      await verifier.writeFile(workspace.inputPath, new Uint8Array(bytes));

      await checkedExec(verifier, [
        "-hide_banner",
        "-v",
        "error",
        "-xerror",
        "-i",
        workspace.inputPath,
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-c:a",
        "pcm_s16le",
        "-threads:a",
        "1",
        "-f",
        "s16le",
        pcmPath,
      ]);

      const decoded = await verifier.readFile(pcmPath);

      check(
        decoded instanceof Uint8Array && decoded.length > 0 && decoded.length % 4 === 0,
        "Public trimmed audio did not decode to stereo PCM.",
      );

      const decodedSamples = decoded.length / 4;

      if (item.preset === "audio-pcm-v1") {
        check(decodedSamples === 6000, "Public trimmed PCM changed the requested sample count.");

        equalBytes(
          decoded,
          expectedPCM,
          "Public trimmed PCM differs from the requested source interval.",
        );
      }

      await workspace.cleanup();
      await assertNoWorkspaces(verifier);

      equalBytes(
        await readOutput(item.output),
        item.snapshot,
        "Verification changed the public trimmed output.",
      );

      results.push({
        preset: item.preset,
        case: item.case,
        inputKind: item.inputKind,
        outputKind: item.outputKind,
        outputBytes: bytes.length,
        decodedSamples,
      });
    }
  } catch (error) {
    throw new Error(
      `Public trimmed audio verification failed during ${phase}.\n` + describeError(error),
      { cause: error },
    );
  } finally {
    verifier.terminate();
  }

  equalBytes(source, sourceSnapshot, "Caller source changed.");

  for (const item of retained) {
    equalBytes(
      await readOutput(item.output),
      item.snapshot,
      "Public trimmed output changed after verifier termination.",
    );
  }

  return results;
}

export async function runPublicBrowserAudioSelectionSmoke(origin) {
  const worker = new FFmpeg();
  const retained = [];
  const results = [];
  let workspace;

  async function decode(path, streamIndex, outputPath) {
    await checkedExec(worker, [
      "-hide_banner",
      "-v",
      "error",
      "-xerror",
      "-i",
      path,
      "-map",
      "0:" + streamIndex,
      "-vn",
      "-sn",
      "-dn",
      "-c:a",
      "pcm_s16le",
      "-threads:a",
      "1",
      "-f",
      "s16le",
      outputPath,
    ]);
    const bytes = await worker.readFile(outputPath);
    check(
      bytes instanceof Uint8Array && bytes.length > 0 && bytes.length % 2 === 0,
      "Expected decoded mono PCM.",
    );
    return bytes;
  }

  try {
    await load(worker, origin);
    workspace = await createBrowserWorkspace(worker, "public-audio-selection");
    const sourcePath = workspace.directory + "/multi.mp4";
    const silentPath = workspace.directory + "/video-only.mp4";

    await checkedExec(worker, [
      "-hide_banner",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=64x36:rate=12:duration=0.5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=0.5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:sample_rate=44100:duration=0.5",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-map",
      "2:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-threads:v",
      "1",
      "-c:a",
      "aac",
      "-threads:a",
      "1",
      "-f",
      "mp4",
      sourcePath,
    ]);

    await checkedExec(worker, [
      "-hide_banner",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=64x36:rate=12:duration=0.5",
      "-map",
      "0:v:0",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-threads:v",
      "1",
      "-f",
      "mp4",
      silentPath,
    ]);

    const source = await worker.readFile(sourcePath);
    const videoOnly = await worker.readFile(silentPath);
    check(
      source instanceof Uint8Array && videoOnly instanceof Uint8Array,
      "Expected generated fixture bytes.",
    );

    const sourceSnapshot = source.slice();
    const silentSnapshot = videoOnly.slice();
    const references = new Map();

    for (const index of [1, 2]) {
      references.set(
        index,
        await decode(sourcePath, index, workspace.directory + "/reference-" + index + ".pcm"),
      );
    }

    for (const preset of ["audio-balanced-v1", "audio-pcm-v1"]) {
      const format = preset === "audio-balanced-v1" ? "mp3" : "wav";
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

      async function exportAudio(input, streamIndex, outputKind, extract = true) {
        let pipeline = client.from(input);
        if (extract) {
          pipeline =
            streamIndex === undefined
              ? pipeline.extractAudio()
              : pipeline.extractAudio({ streamIndex });
        }
        return pipeline.convert({ format, preset }).export({ output: { kind: outputKind } });
      }

      async function retain(operation, streamIndex, inputKind = "bytes", outputKind = "bytes") {
        const selectedIndex = streamIndex ?? 1;
        const sampleRate = selectedIndex === 1 ? 48000 : 44100;
        const input =
          inputKind === "bytes"
            ? { kind: "bytes", bytes: source }
            : { kind: "blob", blob: new Blob([source], { type: "video/mp4" }) };

        const result = await exportAudio(input, streamIndex, outputKind);
        const audio = result.metadata.streams[0];

        check(
          result.engine.id === "browser-ffmpeg" &&
            result.output.kind === outputKind &&
            result.metadata.container === format &&
            result.metadata.streams.length === 1 &&
            audio.kind === "audio" &&
            audio.codec === (format === "mp3" ? "mp3" : "pcm_s16le") &&
            audio.sampleRate === sampleRate &&
            audio.channels === 1,
          "Audio selection changed the requested stream profile.",
        );

        if (outputKind === "blob") {
          check(
            result.output.blob.type === (format === "mp3" ? "audio/mpeg" : "audio/wav"),
            "Unexpected audio Blob MIME type.",
          );
        }

        const bytes =
          result.output.kind === "bytes"
            ? result.output.bytes
            : new Uint8Array(await result.output.blob.arrayBuffer());

        check(
          bytes.length > 0 && result.metadata.sizeBytes === bytes.length,
          "Unexpected audio output size.",
        );

        retained.push({
          preset,
          operation,
          inputKind,
          outputKind,
          selectedIndex,
          sampleRate,
          output: result.output,
          snapshot: bytes.slice(),
        });

        equalBytes(source, sourceSnapshot, "Extraction changed caller bytes.");
        if (input.kind === "blob") {
          equalBytes(
            new Uint8Array(await input.blob.arrayBuffer()),
            sourceSnapshot,
            "Extraction changed caller Blob content.",
          );
        }
      }

      try {
        const metadata = await client.from({ kind: "bytes", bytes: source }).metadata();
        check(
          metadata.streams.length === 3 &&
            metadata.streams[0].kind === "video" &&
            metadata.streams[0].index === 0 &&
            metadata.streams[1].kind === "audio" &&
            metadata.streams[1].index === 1 &&
            metadata.streams[1].sampleRate === 48000 &&
            metadata.streams[2].kind === "audio" &&
            metadata.streams[2].index === 2 &&
            metadata.streams[2].sampleRate === 44100,
          "Generated fixture stream indexes or sample rates differ.",
        );

        for (const inputKind of ["bytes", "blob"]) {
          for (const outputKind of ["bytes", "blob"]) {
            await retain("default", undefined, inputKind, outputKind);
            await retain("explicit-second", 2, inputKind, outputKind);
          }
        }

        for (const item of [
          {
            name: "video-index",
            bytes: source,
            index: 0,
            code: "INVALID_OPTIONS",
            reason: "INVALID_STREAM_INDEX",
            extract: true,
          },
          {
            name: "absent-index",
            bytes: source,
            index: 99,
            code: "INVALID_OPTIONS",
            reason: "INVALID_STREAM_INDEX",
            extract: true,
          },
          {
            name: "missing-audio-default",
            bytes: videoOnly,
            code: "INVALID_MEDIA",
            reason: "MISSING_AUDIO",
            extract: false,
          },
          {
            name: "missing-audio-extraction",
            bytes: videoOnly,
            code: "INVALID_MEDIA",
            reason: "MISSING_AUDIO",
            extract: true,
          },
        ]) {
          let failure;
          try {
            await exportAudio(
              { kind: "bytes", bytes: item.bytes },
              item.index,
              "bytes",
              item.extract,
            );
          } catch (error) {
            failure = error;
          }

          check(
            failure?.code === item.code && failure?.details?.reason === item.reason,
            "Unexpected rejection for " + item.name,
          );
          equalBytes(source, sourceSnapshot, "Rejected extraction changed source.");
          equalBytes(videoOnly, silentSnapshot, "Rejected extraction changed video-only source.");

          await retain("recover-" + item.name, undefined);
        }
      } finally {
        await client.dispose();
      }
    }

    // Both public clients are disposed before independent output verification.
    for (const [index, item] of retained.entries()) {
      const bytes =
        item.output.kind === "bytes"
          ? item.output.bytes
          : new Uint8Array(await item.output.blob.arrayBuffer());
      equalBytes(bytes, item.snapshot, "Output changed after client disposal.");

      const path = workspace.directory + "/output-" + index;
      await worker.writeFile(path, new Uint8Array(bytes));
      const decoded = await decode(path, 0, path + ".pcm");

      if (item.preset === "audio-pcm-v1") {
        equalBytes(
          decoded,
          references.get(item.selectedIndex),
          "Extracted PCM differs from the independently decoded selected track.",
        );
      }

      results.push({
        preset: item.preset,
        operation: item.operation,
        inputKind: item.inputKind,
        outputKind: item.outputKind,
        selectedIndex: item.selectedIndex,
        sampleRate: item.sampleRate,
        channels: 1,
        decodedSamples: decoded.length / 2,
        outputBytes: bytes.length,
      });
    }

    equalBytes(await worker.readFile(sourcePath), sourceSnapshot, "Staged source changed.");
    equalBytes(source, sourceSnapshot, "Caller source changed.");
    equalBytes(videoOnly, silentSnapshot, "Caller video-only source changed.");
  } catch (error) {
    throw new Error("Public audio selection failed.\n" + describeError(error), { cause: error });
  } finally {
    try {
      if (workspace) await workspace.cleanup();
      if (worker.loaded) await assertNoWorkspaces(worker);
    } finally {
      worker.terminate();
    }
  }

  for (const item of retained) {
    const bytes =
      item.output.kind === "bytes"
        ? item.output.bytes
        : new Uint8Array(await item.output.blob.arrayBuffer());
    equalBytes(bytes, item.snapshot, "Output changed after verifier termination.");
  }

  return results;
}
