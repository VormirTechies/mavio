import { FFmpeg } from "/wrapper/index.js";
import { createMavio } from "/mavio.mjs";
import { discoverBrowserInventory } from "../packages/mavio/dist/engines/browser/inventory.js";
import { createBrowserWorkspace } from "../packages/mavio/dist/engines/browser/workspace.js";
import { parseBrowserProbeDetails } from "../packages/mavio/dist/engines/browser/probe-details.js";
import { executeBrowserMp4File } from "../packages/mavio/dist/engines/browser/mp4-execution.js";
import { validateBrowserMp4Output } from "../packages/mavio/dist/engines/browser/mp4-output.js";
import { prepareBrowserMp4Bytes } from "../packages/mavio/dist/engines/browser/mp4-bytes.js";
import { buildBrowserTrimPlan } from "../packages/mavio/dist/engines/browser/trim-plan.js";
import { analyzeBrowserTrimSelection } from "../packages/mavio/dist/engines/browser/trim-analysis.js";

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function describeError(error) {
  const lines = [];
  const seen = new Set();
  let current = error;

  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (current === null || typeof current !== "object") {
      lines.push(String(current));
      break;
    }

    if (seen.has(current)) {
      break;
    }

    seen.add(current);

    lines.push(
      `${current.name ?? "Error"}: ${current.message ?? "Unknown error"}` +
        ` [code=${current.code ?? "-"},` +
        ` stage=${current.stage ?? "-"},` +
        ` reason=${current.details?.reason ?? "-"}]`,
    );

    current = current.cause;
  }

  return lines.join("\nCaused by: ");
}

function equalBytes(actual, expected, message) {
  check(
    actual instanceof Uint8Array &&
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]),
    message,
  );
}

async function inspectRecordedAudio(origin, sequence) {
  const failedEntry = sequence.at(-1);
  const originalArgs = failedEntry?.args[0];

  if (
    failedEntry?.method !== "exec" ||
    !Array.isArray(originalArgs) ||
    !originalArgs.includes("pcm_s16le") ||
    !originalArgs.includes("s16le")
  ) {
    return "Fresh audio check unavailable: failing call is not PCM audio decoding.";
  }

  const inputIndex = originalArgs.indexOf("-i");

  if (inputIndex < 0) {
    return "Fresh audio check unavailable: no input argument.";
  }

  const inputPath = originalArgs[inputIndex + 1];

  const capturedWrite = [...sequence]
    .reverse()
    .find(
      (entry) =>
        entry.method === "writeFile" && entry.status === "fulfilled" && entry.args[0] === inputPath,
    );

  if (!(capturedWrite?.args[1] instanceof Uint8Array)) {
    return "Fresh audio check unavailable: input bytes were not captured.";
  }

  // Recorder snapshots preserve bytes before writeFile transfers them.
  const capturedBytes = new Uint8Array(capturedWrite.args[1]);
  const isolatedWorker = new FFmpeg();
  const recentLogs = [];

  let phase = "loading worker";
  let deadlineReached = false;
  let errorDiagnostic = false;

  isolatedWorker.on("log", ({ type, message }) => {
    recentLogs.push(message);
    if (recentLogs.length > 12) recentLogs.shift();

    const text = message.trim();

    if (type === "stderr" && text !== "" && text !== "Aborted()") {
      errorDiagnostic = true;
    }
  });

  const timer = setTimeout(() => {
    deadlineReached = true;
    isolatedWorker.terminate();
  }, 30_000);

  try {
    await isolatedWorker.load({
      classWorkerURL: new URL("/wrapper/worker.js", origin).href,
      coreURL: new URL("/core/ffmpeg-core.js", origin).href,
      wasmURL: new URL("/core/ffmpeg-core.wasm", origin).href,
    });

    phase = "staging captured MP4";

    const workspace = await createBrowserWorkspace(isolatedWorker, "audio-isolation");

    await isolatedWorker.writeFile(workspace.inputPath, capturedBytes);

    const outputPath = `${workspace.directory}/isolated.pcm`;
    const args = [...originalArgs];

    // Preserve the command options; remap only owned file paths.
    args[inputIndex + 1] = workspace.inputPath;
    args[args.length - 1] = outputPath;

    phase = "decoding captured MP4 audio";

    const exitCode = await isolatedWorker.exec(args);

    if (exitCode !== 0 || errorDiagnostic) {
      return (
        `Fresh audio check FAILED: exit=${exitCode}, ` +
        `errorDiagnostic=${errorDiagnostic}.\n` +
        recentLogs.join("\n")
      );
    }

    phase = "reading decoded PCM";

    const pcm = await isolatedWorker.readFile(outputPath);

    if (!(pcm instanceof Uint8Array) || pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
      return "Fresh audio check FAILED: invalid or empty mono PCM output.";
    }

    return (
      `Fresh audio check PASSED: the captured MP4 decoded to ` +
      `${pcm.byteLength / 2} mono PCM samples with exit 0.`
    );
  } catch (error) {
    return (
      `Fresh audio check ${deadlineReached ? "TIMED OUT" : "FAILED"} ` +
      `during ${phase}:\n${describeError(error)}\n` +
      `Recent isolated logs:\n${recentLogs.join("\n")}`
    );
  } finally {
    clearTimeout(timer);

    // Termination also releases this diagnostic worker's private files.
    isolatedWorker.terminate();
  }
}

function recordWorkerCalls(worker) {
  const entries = [];

  const methods = [
    "createDir",
    "deleteDir",
    "listDir",
    "writeFile",
    "readFile",
    "deleteFile",
    "exec",
    "ffprobe",
  ];

  for (const method of methods) {
    const original = worker[method].bind(worker);

    worker[method] = async (...args) => {
      // Capture before writeFile can transfer its input buffer.
      const entry = {
        method,
        args: structuredClone(args),
        status: "pending",
      };

      entries.push(entry);

      try {
        const result = await original(...args);
        entry.status = "fulfilled";

        if (method === "exec" || method === "ffprobe") {
          entry.exitCode = result;
        }

        return result;
      } catch (error) {
        entry.status = "rejected";
        entry.error = String(error);
        throw error;
      }
    };
  }

  return async function replayRecordedCalls(origin) {
    const trapIndex = entries.findIndex(
      (entry) => entry.status === "rejected" && /memory access out of bounds/i.test(entry.error),
    );

    if (trapIndex === -1) {
      return "Replay unavailable: no recorded memory trap in the smoke worker.";
    }

    // Exclude cleanup attempted after the original trap.
    const sequence = entries.slice(0, trapIndex + 1);

    function encodeTraceValue(value) {
      if (value instanceof Uint8Array) {
        return {
          __mavioTraceType: "Uint8Array",
          bytes: Array.from(value),
        };
      }

      if (Array.isArray(value)) {
        return value.map(encodeTraceValue);
      }

      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, encodeTraceValue(item)]),
        );
      }

      return value;
    }

    await globalThis.__mavioSaveRegression(
      JSON.stringify({
        schemaVersion: 1,
        wrapperVersion: "0.12.15",
        coreVersion: "0.12.10",
        entries: encodeTraceValue(sequence),
      }),
    );

    const audioAnalysisIndices = [];

    for (const [index, entry] of sequence.entries()) {
      const args = entry.args[0];

      if (
        entry.status === "fulfilled" &&
        entry.method === "exec" &&
        Array.isArray(args) &&
        args.includes("framemd5") &&
        args.includes("pcm_f32le") &&
        args.at(-1) === "pipe:1"
      ) {
        audioAnalysisIndices.push(index);
      }
    }

    // Diagnostic experiment: omit successful checksum-only calls
    // from the replay. The original failing sequence stays unchanged.
    const checksumIndices = [];

    for (const [index, entry] of sequence.entries()) {
      const args = entry.args[0];

      if (
        entry.status === "fulfilled" &&
        entry.method === "exec" &&
        Array.isArray(args) &&
        args.includes("framemd5") &&
        args.at(-1) === "pipe:1"
      ) {
        checksumIndices.push(index);
      }
    }

    const omittedIndices = new Set();

    for (const index of checksumIndices.slice(0, 3)) {
      console.log(
        `[trim-debug] Candidate call ${index + 1}: ` + JSON.stringify(sequence[index].args),
      );
    }

    const audioIsolation = await inspectRecordedAudio(origin, sequence);

    console.log(`[trim-debug] ${audioIsolation}`);

    const replayWorker = new FFmpeg();
    const recentLogs = [];

    let phase = "loading replay worker";
    let deadlineReached = false;

    replayWorker.on("log", ({ message }) => {
      recentLogs.push(message);

      if (recentLogs.length > 15) {
        recentLogs.shift();
      }
    });

    const timer = setTimeout(() => {
      deadlineReached = true;

      console.log(`[trim-debug] Replay deadline reached: ${phase}`);

      replayWorker.terminate();
    }, 60_000);

    try {
      console.log(`[trim-debug] Audio analysis calls found: ${audioAnalysisIndices.length}.`);
      console.log(`[trim-debug] Full candidate replay: ${omittedIndices.size} calls omitted.`);
      console.log(`[trim-debug] Replaying ${sequence.length} recorded calls.`);

      await replayWorker.load({
        classWorkerURL: new URL("/wrapper/worker.js", origin).href,
        coreURL: new URL("/core/ffmpeg-core.js", origin).href,
        wasmURL: new URL("/core/ffmpeg-core.wasm", origin).href,
      });

      for (const [index, entry] of sequence.entries()) {
        if (omittedIndices.has(index)) {
          continue;
        }
        phase = `call ${index + 1}/${sequence.length}: ${entry.method}`;

        if (index >= trapIndex - 10 && (entry.method === "exec" || entry.method === "ffprobe")) {
          console.log(`[trim-debug] ${phase} ${JSON.stringify(entry.args[0])}`);
        }

        let result;

        try {
          const replayArgs = structuredClone(entry.args);
          const command = replayArgs[0];

          if (
            entry.method === "exec" &&
            Array.isArray(command) &&
            command.includes("framemd5") &&
            !command.includes("-filter_threads")
          ) {
            command.unshift("-filter_threads", "1");

            console.log(`[trim-debug] Single filter thread applied at call ${index + 1}.`);
          }

          result = await replayWorker[entry.method](...replayArgs);
        } catch (error) {
          if (deadlineReached) {
            return `Replay TIMED OUT during ${phase}.`;
          }

          if (index === trapIndex) {
            const reproduced = /memory access out of bounds/i.test(String(error));

            return (
              (reproduced
                ? `Replay REPRODUCED the memory trap at ${phase}.\n`
                : `Replay reached ${phase} but threw a different error.\n`) +
              `Failure: ${String(error)}\n` +
              `Arguments: ${JSON.stringify(entry.args)}\n` +
              `Recent replay logs:\n${recentLogs.join("\n")}`
            );
          }

          // Preserve matching failures from earlier filesystem checks.
          if (entry.status === "rejected" && String(error) === entry.error) {
            continue;
          }

          return (
            `Replay diverged during ${phase}.\n` +
            `Failure: ${String(error)}\n` +
            `Arguments: ${JSON.stringify(entry.args)}\n` +
            `Recent replay logs:\n${recentLogs.join("\n")}`
          );
        }

        if (entry.status === "rejected") {
          return (
            `Replay did NOT reproduce the original rejection ` +
            `at ${phase}.\n` +
            `Returned result: ${String(result)}.\n` +
            `Arguments: ${JSON.stringify(entry.args)}`
          );
        }

        if ((entry.method === "exec" || entry.method === "ffprobe") && result !== entry.exitCode) {
          return (
            `Replay exit code diverged during ${phase}: ` +
            `original=${entry.exitCode}, replay=${result}.\n` +
            `Command: ${JSON.stringify(entry.args[0])}`
          );
        }
      }

      return "Replay completed without reproducing the trap.";
    } catch (error) {
      return (
        `Replay ${deadlineReached ? "TIMED OUT" : "FAILED"} ` +
        `during ${phase}:\n${describeError(error)}`
      );
    } finally {
      clearTimeout(timer);
      replayWorker.terminate();
    }
  };
}

export async function runBrowserMp4Smoke(origin) {
  const worker = new FFmpeg();
  const replayRecordedCalls = recordWorkerCalls(worker);

  const logs = [];
  const retained = [];
  const results = [];
  const publicReturned = [];

  let publicClient;
  let recoverySource;
  let recoveryHasAudio = false;
  let smokePhase = "initialization";

  worker.on("log", ({ message }) => {
    logs.push(message);

    if (logs.length > 25) {
      logs.shift();
    }
  });

  const context = {
    jobId: "browser-mp4-smoke",
    signal: new AbortController().signal,
    reportProgress() {},
  };

  async function exec(args, label) {
    const code = await worker.exec(args);
    check(code === 0, `${label} failed with exit ${code}.`);
  }

  async function workspaceNames() {
    return (await worker.listDir("/"))
      .filter((entry) => entry.isDir && entry.name.startsWith("mavio-"))
      .map((entry) => entry.name)
      .sort();
  }

  async function verifyPrepared(prepared, workspace, label, hasAudio, expectedFrames = 6) {
    const stagedPath = `${workspace.directory}/${label}.mp4`;
    const videoPath = `${workspace.directory}/${label}.yuv`;
    const audioPath = `${workspace.directory}/${label}.pcm`;

    const snapshot = prepared.bytes.slice();

    // Preserve the caller's returned bytes when staging.
    await worker.writeFile(stagedPath, new Uint8Array(prepared.bytes));

    await exec(
      [
        "-hide_banner",
        "-v",
        "error",
        "-xerror",
        "-i",
        stagedPath,
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
      `${label}: prepared video decoding`,
    );

    const video = await worker.readFile(videoPath);

    check(
      video instanceof Uint8Array && video.byteLength === ((160 * 90 * 3) / 2) * expectedFrames,
      `Prepared output must decode to ${expectedFrames} video frames.`,
    );

    if (hasAudio) {
      await exec(
        [
          "-hide_banner",
          "-v",
          "error",
          "-xerror",
          "-i",
          stagedPath,
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
        `${label}: prepared audio decoding`,
      );

      const audio = await worker.readFile(audioPath);

      check(
        audio instanceof Uint8Array && audio.byteLength > 0 && audio.byteLength % 2 === 0,
        "Prepared audio must decode to mono PCM samples.",
      );
    }

    equalBytes(
      prepared.bytes,
      snapshot,
      "Decoding detached or changed the returned prepared bytes.",
    );

    retained.push({
      bytes: prepared.bytes,
      snapshot,
    });
  }

  async function verifyTrimmed(prepared, workspace, label, hasAudio, expectedTimes) {
    // Preparation has already removed its private workspace.
    await verifyPrepared(prepared, workspace, label, hasAudio, expectedTimes.length);

    const stagedPath = `${workspace.directory}/${label}.mp4`;
    const reportPath = `${workspace.directory}/${label}-frames.json`;

    check(
      !(await worker.listDir(workspace.directory)).some(
        (entry) => entry.name === `${label}-frames.json`,
      ),
      "Frame timestamp report must be fresh.",
    );

    const code = await worker.ffprobe([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_frames",
      "-show_entries",
      "frame=best_effort_timestamp_time",
      "-of",
      "json",
      stagedPath,
      "-o",
      reportPath,
    ]);

    check(code === 0 || code === -1, `Frame timestamp probing failed with exit ${code}.`);

    const text = await worker.readFile(reportPath, "utf8");

    check(typeof text === "string", "Expected frame timestamp JSON.");

    const report = JSON.parse(text);

    check(
      report !== null &&
        typeof report === "object" &&
        report.error === undefined &&
        Array.isArray(report.frames) &&
        report.frames.length === expectedTimes.length,
      "Unexpected frame timestamp report.",
    );

    for (const [index, frame] of report.frames.entries()) {
      const value = frame?.best_effort_timestamp_time;

      check(
        typeof value === "string" &&
          /^-?\d+(?:\.\d+)?$/.test(value) &&
          Number.isFinite(Number(value)),
        "Missing or invalid frame timestamp.",
      );

      check(
        Math.abs(Number(value) - expectedTimes[index]) <= 0.0000011,
        `Unexpected trim timestamp at frame ${index}: ${value}.`,
      );
    }

    await worker.deleteFile(reportPath);

    if (hasAudio) {
      // AAC decoders can return a padded final frame; presentation timing must
      // still describe exactly the requested interval after the MP4 edit list.
      const selectedSamples = expectedTimes.length === 3 ? 12_000 : 6_000;
      const pcm = await worker.readFile(`${workspace.directory}/${label}.pcm`);
      check(
        pcm instanceof Uint8Array &&
          pcm.byteLength / 2 === Math.ceil(selectedSamples / 1024) * 1024,
        "Trimmed AAC decoded sample count differs from the pinned decoder padding contract.",
      );
      const audioCode = await worker.ffprobe([
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_streams",
        "-show_entries",
        "stream=start_time,duration,sample_rate,channels",
        "-of",
        "json",
        stagedPath,
        "-o",
        reportPath,
      ]);
      check(audioCode === 0 || audioCode === -1, "Trimmed audio timing probe failed.");
      const audioText = await worker.readFile(reportPath, "utf8");
      check(typeof audioText === "string", "Missing audio timing report.");
      const audioReport = JSON.parse(audioText);
      check(
        audioReport.error === undefined && audioReport.streams?.length === 1,
        "Unexpected audio timing report.",
      );
      const timing = audioReport.streams[0];
      check(
        Math.abs(Number(timing.start_time)) <= 0.000001 &&
          Math.abs(Number(timing.duration) - selectedSamples / 48000) <= 0.000001 &&
          Number(timing.sample_rate) === 48000 &&
          timing.channels === 1,
        "Trimmed audio presentation timing differs from the selected source interval.",
      );
      await worker.deleteFile(reportPath);
    }
  }

  async function savePublicResult(result, hasAudio, expectedTimes) {
    check(result.engine.id === "browser-ffmpeg", "Public export used an unexpected engine.");

    check(
      typeof result.jobId === "string" && result.jobId.length > 0,
      "Public export returned no job ID.",
    );

    const blob = result.output.kind === "blob" ? result.output.blob : undefined;

    if (blob !== undefined) {
      check(blob.type === "video/mp4", "Wrong public Blob MIME type.");
    }

    const bytes =
      result.output.kind === "bytes"
        ? result.output.bytes
        : new Uint8Array(await result.output.blob.arrayBuffer());

    check(
      bytes.byteLength === result.metadata.sizeBytes,
      "Public output bytes disagree with metadata.",
    );

    publicReturned.push({
      prepared: {
        bytes,
        metadata: result.metadata,
      },
      snapshot: bytes.slice(),
      blob,
      hasAudio,
      expectedTimes,
    });
  }

  async function probe(inputPath, workspace) {
    const entries = await worker.listDir(workspace.directory);

    check(!entries.some((entry) => entry.name === "probe.json"), "Probe output must be fresh.");

    const code = await worker.ffprobe([
      "-v",
      "error",
      "-show_error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      inputPath,
      "-o",
      workspace.probePath,
    ]);

    const text = await worker.readFile(workspace.probePath, "utf8");

    check(typeof text === "string", "Expected probe JSON text.");

    await worker.deleteFile(workspace.probePath);

    return parseBrowserProbeDetails(text, code, context.jobId);
  }

  try {
    await worker.load({
      classWorkerURL: new URL("/wrapper/worker.js", origin).href,
      coreURL: new URL("/core/ffmpeg-core.js", origin).href,
      wasmURL: new URL("/core/ffmpeg-core.wasm", origin).href,
    });

    const inventory = await discoverBrowserInventory(worker, context);

    publicClient = createMavio({
      initTimeoutMs: 60_000,
      browser: {
        assets: {
          coreURL: new URL("/core/ffmpeg-core.js", origin).href,
          wasmURL: new URL("/core/ffmpeg-core.wasm", origin).href,
          classWorkerURL: new URL("/wrapper/worker.js", origin).href,
        },
      },
    });

    for (const preset of ["video-balanced-v1", "video-small-v1"]) {
      for (const hasAudio of [false, true]) {
        const caseLabel = `preset=${preset}, audio=${hasAudio}`;

        smokePhase = `${caseLabel}: fixture generation`;

        const workspace = await createBrowserWorkspace(worker, context.jobId);

        const outputPath = `${workspace.directory}/output.mp4`;

        const decodedVideoPath = `${workspace.directory}/decoded.yuv`;

        const decodedAudioPath = `${workspace.directory}/decoded.pcm`;

        const generation = [
          "-hide_banner",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=160x90:rate=12:duration=0.5",
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
          "0.5",
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

        // This fixture destination is inside a new directory.
        await exec(generation, "Fixture generation");

        const source = await probe(workspace.inputPath, workspace);

        const sourceBytes = await worker.readFile(workspace.inputPath);

        check(sourceBytes instanceof Uint8Array, "Expected binary source bytes.");

        const sourceSnapshot = sourceBytes.slice();

        async function analyzeTrim(transformations) {
          const video = source.metadata.streams.find((stream) => stream.kind === "video");

          const audio = source.metadata.streams.find((stream) => stream.kind === "audio");

          check(video !== undefined, "Trim fixture has no video.");

          const filters = buildBrowserTrimPlan(
            transformations,
            source.metadata.durationSeconds,
            source.formatStartTimeSeconds,
            audio !== undefined,
            inventory,
          );

          check(filters !== undefined, "Expected a trim plan.");

          return analyzeBrowserTrimSelection(
            worker,
            {
              inputPath: workspace.inputPath,
              videoStreamIndex: video.index,
              ...(audio === undefined
                ? {}
                : {
                    audio: {
                      streamIndex: audio.index,
                      channels: audio.channels,
                    },
                  }),
              filters,
              inventory,
            },
            context,
          );
        }

        smokePhase = `${caseLabel}: fractional trim analysis`;

        const trimSelection = await analyzeTrim([
          {
            type: "trim",
            options: {
              start: 0.125,
              end: 0.375,
            },
          },
        ]);

        // [0.125, 0.375) selects timestamps 2/12, 3/12, 4/12.
        check(
          trimSelection.videoFrames === 3,
          `Expected three selected frames; received ${trimSelection.videoFrames}.`,
        );

        if (hasAudio) {
          check(
            trimSelection.audioSamples === 12_000,
            `Expected 12000 selected samples; received ${trimSelection.audioSamples}.`,
          );
        } else {
          check(
            trimSelection.audioSamples === undefined,
            "Video-only trim unexpectedly analyzed audio.",
          );
        }

        smokePhase = `${caseLabel}: empty-video trim rejection`;

        let emptyTrimRejected = false;

        try {
          await analyzeTrim([
            {
              type: "trim",
              options: {
                start: 0.01,
                end: 0.02,
              },
            },
          ]);
        } catch (error) {
          if (
            error.code !== "INVALID_OPTIONS" ||
            error.details?.reason !== "RANGE_TOO_SHORT" ||
            error.details?.streamKind !== "video"
          ) {
            throw error;
          }

          emptyTrimRejected = true;
        }

        check(emptyTrimRejected, "An interval containing no video frames should reject.");

        check(worker.loaded, "Selection-only rejection unexpectedly terminated the worker.");

        smokePhase = `${caseLabel}: consecutive trim analysis`;

        // The second trim is relative to the first clip.
        // Combined source interval: [0.25, 0.375).
        const consecutiveSelection = await analyzeTrim([
          {
            type: "trim",
            options: {
              start: 0.125,
              end: 0.5,
            },
          },
          {
            type: "trim",
            options: {
              start: 0.125,
              end: 0.25,
            },
          },
        ]);

        check(
          consecutiveSelection.videoFrames === 2,
          "Consecutive trims should select two source frames.",
        );

        if (hasAudio) {
          check(
            consecutiveSelection.audioSamples === 6_000,
            "Consecutive trims should select 6000 samples per channel.",
          );
        }

        equalBytes(
          await worker.readFile(workspace.inputPath),
          sourceSnapshot,
          "Trim analysis changed the staged source.",
        );

        check(
          !(await worker.listDir(workspace.directory)).some((entry) => entry.name === "output.mp4"),
          "Selection analysis unexpectedly created an encoded output.",
        );

        const options = {
          plan: {
            input: {
              kind: "bytes",
              bytes: sourceBytes,
            },
            transformations: [
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
            output: {
              kind: "bytes",
            },
          },
          source,
          inventory,
          inputPath: workspace.inputPath,
          outputPath,
        };

        smokePhase = `${caseLabel}: MP4 encoding`;

        await executeBrowserMp4File(worker, options, context);

        const output = await probe(outputPath, workspace);
        const bytes = await worker.readFile(outputPath);

        check(bytes instanceof Uint8Array, "Expected binary MP4 output.");

        validateBrowserMp4Output(
          output,
          {
            width: 160,
            height: 90,
            preset,
            ...(hasAudio
              ? {
                  audio: {
                    sampleRate: 48000,
                    channels: 1,
                    channelLayout: "mono",
                  },
                }
              : {}),
          },
          bytes,
          context.jobId,
        );

        const outputSnapshot = bytes.slice();

        smokePhase = `${caseLabel}: overwrite protection`;

        let overwriteCode;

        try {
          await executeBrowserMp4File(worker, options, context);

          overwriteCode = "UNEXPECTED_SUCCESS";
        } catch (error) {
          overwriteCode = error.code;
        }

        check(
          overwriteCode === "OUTPUT_EXISTS",
          `Expected overwrite rejection; received ${overwriteCode}.`,
        );

        equalBytes(
          await worker.readFile(outputPath),
          outputSnapshot,
          "Overwrite rejection changed the existing output.",
        );

        smokePhase = `${caseLabel}: video decoding`;

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
            decodedVideoPath,
          ],
          "Video decoding",
        );

        const decodedVideo = await worker.readFile(decodedVideoPath);

        const frameBytes = (160 * 90 * 3) / 2;

        check(
          decodedVideo instanceof Uint8Array && decodedVideo.byteLength === frameBytes * 6,
          "Expected exactly six decoded video frames.",
        );

        let decodedAudioSamples = 0;

        if (hasAudio) {
          smokePhase = `${caseLabel}: audio decoding`;

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
              decodedAudioPath,
            ],
            "Audio decoding",
          );

          const decodedAudio = await worker.readFile(decodedAudioPath);

          check(
            decodedAudio instanceof Uint8Array &&
              decodedAudio.byteLength > 0 &&
              decodedAudio.byteLength % 2 === 0,
            "Expected decoded mono PCM audio.",
          );

          // Record actual samples without assuming padding-free AAC.
          decodedAudioSamples = decodedAudio.byteLength / 2;
        }

        equalBytes(
          await worker.readFile(workspace.inputPath),
          sourceSnapshot,
          "Encoding changed the staged source file.",
        );

        retained.push(
          {
            bytes,
            snapshot: outputSnapshot,
          },
          {
            bytes: sourceBytes,
            snapshot: sourceSnapshot,
          },
        );

        let preparedInputs = 0;

        const preparedInputCases = [
          {
            label: "prepared-bytes",
            input: {
              kind: "bytes",
              bytes: sourceBytes,
              name: "../../caller-name.mp4",
            },
          },
          {
            label: "prepared-blob",
            input: {
              kind: "blob",
              blob: new Blob([sourceBytes], { type: "video/mp4" }),
            },
          },
        ];

        for (const { label, input } of preparedInputCases) {
          smokePhase = `${caseLabel}: ${label} preparation`;

          const beforeWorkspaces = await workspaceNames();

          const prepared = await prepareBrowserMp4Bytes(
            worker,
            {
              ...options.plan,
              input,
              output: {
                kind: "bytes",
              },
            },
            inventory,
            context,
          );

          check(worker.loaded, "Successful preparation terminated the worker.");

          check(
            JSON.stringify(await workspaceNames()) === JSON.stringify(beforeWorkspaces),
            "Preparation left a workspace behind.",
          );

          check(
            prepared.metadata.sizeBytes === prepared.bytes.byteLength,
            "Prepared byte size disagrees with metadata.",
          );

          const videos = prepared.metadata.streams.filter((stream) => stream.kind === "video");

          const audios = prepared.metadata.streams.filter((stream) => stream.kind === "audio");

          check(
            videos.length === 1 && videos[0].width === 160 && videos[0].height === 90,
            "Prepared video dimensions changed.",
          );

          check(
            audios.length === (hasAudio ? 1 : 0),
            "Prepared output has an unexpected audio stream count.",
          );

          equalBytes(
            sourceBytes,
            sourceSnapshot,
            "Preparation detached or modified caller input bytes.",
          );

          if (input.kind === "blob") {
            equalBytes(
              new Uint8Array(await input.blob.arrayBuffer()),
              sourceSnapshot,
              "Preparation modified caller Blob content.",
            );
          }

          smokePhase = `${caseLabel}: ${label} verification`;

          await verifyPrepared(prepared, workspace, label, hasAudio);

          preparedInputs += 1;
        }

        let trimmedPreparations = 0;

        const trimmedCases = [
          {
            label: "trimmed-bytes",
            input: {
              kind: "bytes",
              bytes: sourceBytes,
            },
            transformations: [
              {
                type: "trim",
                options: {
                  start: 0.125,
                  end: 0.375,
                },
              },
            ],
            // Source timestamps minus requested start 0.125.
            expectedTimes: [0.041667, 0.125, 0.208333],
          },
          {
            label: "trimmed-blob",
            input: {
              kind: "blob",
              blob: new Blob([sourceBytes], { type: "video/mp4" }),
            },
            transformations: [
              {
                type: "trim",
                options: {
                  start: 0.125,
                  end: 0.5,
                },
              },
              {
                type: "trim",
                options: {
                  start: 0.125,
                  end: 0.25,
                },
              },
            ],
            // Combined source interval: [0.25, 0.375).
            expectedTimes: [0, 0.083333],
          },
        ];

        for (const trimCase of trimmedCases) {
          smokePhase = `${caseLabel}: ${trimCase.label} preparation`;

          const beforeWorkspaces = await workspaceNames();

          const trimPlan = {
            ...options.plan,
            input: trimCase.input,
            transformations: [...trimCase.transformations, ...options.plan.transformations],
            output: {
              kind: "bytes",
            },
          };

          const prepared = await prepareBrowserMp4Bytes(worker, trimPlan, inventory, context);

          check(
            JSON.stringify(await workspaceNames()) === JSON.stringify(beforeWorkspaces),
            "Trim preparation left staging behind.",
          );

          equalBytes(sourceBytes, sourceSnapshot, "Trim preparation modified caller bytes.");

          if (trimCase.input.kind === "blob") {
            equalBytes(
              new Uint8Array(await trimCase.input.blob.arrayBuffer()),
              sourceSnapshot,
              "Trim preparation modified caller Blob content.",
            );
          }

          smokePhase = `${caseLabel}: ${trimCase.label} verification`;

          await verifyTrimmed(
            prepared,
            workspace,
            trimCase.label,
            hasAudio,
            trimCase.expectedTimes,
          );

          trimmedPreparations += 1;
        }

        let publicExports = 0;
        let publicTrims = 0;

        for (const trimCase of trimmedCases) {
          for (const kind of ["bytes", "blob"]) {
            smokePhase = `${caseLabel}: public ${trimCase.label}-to-${kind} trim`;
            let pipeline = publicClient.from(trimCase.input);
            for (const operation of trimCase.transformations) {
              pipeline = pipeline.trim(operation.options);
            }
            const result = await pipeline
              .convert({ format: "mp4", preset })
              .export({ output: { kind } });
            check(result.output.kind === kind, "Public trim returned the wrong output kind.");
            await savePublicResult(result, hasAudio, trimCase.expectedTimes);
            equalBytes(sourceBytes, sourceSnapshot, "Public trim changed caller bytes.");
            if (trimCase.input.kind === "blob") {
              equalBytes(
                new Uint8Array(await trimCase.input.blob.arrayBuffer()),
                sourceSnapshot,
                "Public trim changed caller Blob content.",
              );
            }
            publicTrims += 1;
          }
        }

        smokePhase = `${caseLabel}: public empty-video trim rejection`;
        let publicEmptyTrimRejected = false;
        try {
          await publicClient
            .from({ kind: "bytes", bytes: sourceBytes })
            .trim({ start: 0.01, end: 0.02 })
            .convert({ format: "mp4", preset })
            .export({ output: { kind: "bytes" } });
        } catch (error) {
          if (error.code !== "INVALID_OPTIONS" || error.details?.reason !== "RANGE_TOO_SHORT")
            throw error;
          publicEmptyTrimRejected = true;
        }
        check(publicEmptyTrimRejected, "Public empty-video trim must reject.");

        // These exports also prove same-client recovery after the empty trim.
        for (const { input } of preparedInputCases) {
          for (const kind of ["bytes", "blob"]) {
            smokePhase = `${caseLabel}: public ${input.kind}-to-${kind} export`;

            const stages = [];

            const result = await publicClient
              .from(input)
              .convert({
                format: "mp4",
                preset,
              })
              .export(
                {
                  output: {
                    kind,
                  },
                },
                {
                  onProgress(event) {
                    stages.push(event.stage);
                  },
                },
              );

            check(result.output.kind === kind, "Public export returned the wrong output kind.");

            check(
              stages.at(-1) === "completed" &&
                !stages.includes("failed") &&
                !stages.includes("cancelled"),
              "Public export did not complete successfully.",
            );

            await savePublicResult(result, hasAudio);

            equalBytes(
              sourceBytes,
              sourceSnapshot,
              "Public export modified or detached caller bytes.",
            );

            if (input.kind === "blob") {
              equalBytes(
                new Uint8Array(await input.blob.arrayBuffer()),
                sourceSnapshot,
                "Public export modified caller Blob content.",
              );
            }

            publicExports += 1;
          }
        }

        recoverySource = sourceSnapshot.slice();
        recoveryHasAudio = hasAudio;

        results.push({
          preset,
          audio: hasAudio,
          videoFrames: 6,
          outputBytes: bytes.byteLength,
          decodedAudioSamples,
          preparedInputs,
          publicExports,
          publicTrims,
          publicEmptyTrimRejected,
          trimVideoFrames: trimSelection.videoFrames,
          trimAudioSamples: trimSelection.audioSamples ?? 0,
          consecutiveTrimVideoFrames: consecutiveSelection.videoFrames,
          consecutiveTrimAudioSamples: consecutiveSelection.audioSamples ?? 0,
          emptyTrimRejected,
          trimmedPreparations,
        });

        smokePhase = `${caseLabel}: workspace cleanup`;

        await workspace.cleanup();

        equalBytes(bytes, outputSnapshot, "Output bytes changed after workspace cleanup.");
      }
    }

    check(publicReturned.length === 32, "Expected sixteen exports and sixteen public trims.");

    check(recoverySource !== undefined, "Recovery source is missing.");

    smokePhase = "public invalid-media rejection";

    let invalidCode;

    try {
      await publicClient
        .from({
          kind: "bytes",
          bytes: new TextEncoder().encode("This is not media."),
        })
        .convert({
          format: "mp4",
          preset: "video-balanced-v1",
        })
        .export({
          output: {
            kind: "bytes",
          },
        });

      invalidCode = "UNEXPECTED_SUCCESS";
    } catch (error) {
      invalidCode = error.code;
    }

    check(
      invalidCode === "INVALID_MEDIA",
      `Expected invalid-media rejection; received ${invalidCode}.`,
    );

    smokePhase = "public same-client recovery";

    const recovered = await publicClient
      .from({
        kind: "bytes",
        bytes: recoverySource,
      })
      .convert({
        format: "mp4",
        preset: "video-balanced-v1",
      })
      .export({
        output: {
          kind: "bytes",
        },
      });

    await savePublicResult(recovered, recoveryHasAudio);

    smokePhase = "public client disposal";

    await publicClient.dispose();
    publicClient = undefined;

    check(
      publicReturned.length === 33,
      "Expected thirty-two matrix outputs and one recovery output.",
    );

    const verificationWorkspace = await createBrowserWorkspace(worker, context.jobId);

    for (const [index, entry] of publicReturned.entries()) {
      smokePhase = `post-disposal public output ${index} verification`;

      equalBytes(
        entry.prepared.bytes,
        entry.snapshot,
        "Public output changed after client disposal.",
      );

      if (entry.blob !== undefined) {
        equalBytes(
          new Uint8Array(await entry.blob.arrayBuffer()),
          entry.snapshot,
          "Public Blob content changed after disposal.",
        );
      }

      await (entry.expectedTimes === undefined ? verifyPrepared : verifyTrimmed)(
        entry.prepared,
        verificationWorkspace,
        `public-${index}`,
        entry.hasAudio,
        entry.expectedTimes,
      );
    }

    smokePhase = "post-disposal verification cleanup";

    await verificationWorkspace.cleanup();
  } catch (error) {
    const cleanupMessages = [];

    try {
      await publicClient?.dispose();
    } catch (cleanupError) {
      cleanupMessages.push(
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      );
    }

    // Diagnose traps anywhere in the original smoke worker.
    const replayOutcome = await replayRecordedCalls(origin);

    throw new Error(
      `Smoke phase: ${smokePhase}\n` +
        `${describeError(error)}\n\n` +
        `${replayOutcome}\n` +
        (cleanupMessages.length ? `Client cleanup failed: ${cleanupMessages.join("; ")}\n` : "") +
        `Recent engine logs:\n${logs.join("\n")}`,
      { cause: error },
    );
  } finally {
    worker.terminate();
  }

  for (const { bytes, snapshot } of retained) {
    equalBytes(bytes, snapshot, "Retained bytes changed after worker termination.");
  }

  return results;
}
