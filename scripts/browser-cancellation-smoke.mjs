import { createMavio } from "/mavio.mjs";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function equalBytes(actual, expected, message) {
  check(
    actual.length === expected.length && actual.every((value, index) => value === expected[index]),
    message,
  );
}

function makeWav(seconds) {
  const sampleRate = 48000;
  const samples = Math.round(seconds * sampleRate);
  const bytes = new Uint8Array(44 + samples * 4);
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
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, bytes.length - 44, true);

  for (let index = 0; index < samples; index += 1) {
    view.setInt16(44 + index * 4, ((index % 97) - 48) * 200, true);

    view.setInt16(46 + index * 4, ((index % 89) - 44) * 200, true);
  }

  return bytes;
}

export async function runBrowserCancellationSmoke(origin) {
  const source = makeWav(30);
  const snapshot = source.slice();
  const recoverySource = makeWav(0.125);
  const recoverySnapshot = recoverySource.slice();
  const controller = new AbortController();
  const stages = [];

  let targetedExecutions = 0;
  let progressObserved = false;
  let completedBeforeAbort = false;
  let abortTime;
  let cancellationMilliseconds;
  let recoveryBytes;

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
    // Initialize before installing observation of the encoding request.
    await client.capabilities();

    const workerPrototype = globalThis.Worker.prototype;
    const originalPostMessage = workerPrototype.postMessage;

    let observedWorker;
    let observeMessage;

    function observedPostMessage(...sendArgs) {
      const message = sendArgs[0];
      const args = message?.data?.args;

      if (
        message?.type === "EXEC" &&
        Array.isArray(args) &&
        typeof args.at(-1) === "string" &&
        /^\/mavio-[A-Za-z0-9-]+\/output\.mp3$/.test(args.at(-1))
      ) {
        targetedExecutions += 1;

        if (targetedExecutions === 1) {
          const inputIndex = args.indexOf("-i");

          check(inputIndex >= 0, "Cancellation fixture encoding must contain an input.");

          // Pace only this smoke-test request so fast runners have a
          // reliable opportunity to observe active encoding and cancel.
          sendArgs[0] = {
            ...message,
            data: {
              ...message.data,
              args: [
                "-stats_period",
                "0.05",
                ...args.slice(0, inputIndex),
                "-re",
                ...args.slice(inputIndex),
              ],
            },
          };

          observedWorker = this;
          const requestId = message.id;

          observeMessage = (event) => {
            const response = event.data;

            if (
              response?.type === "EXEC" &&
              response.id === requestId &&
              !controller.signal.aborted
            ) {
              completedBeforeAbort = true;
            }

            const progress = response?.data;

            if (
              response?.type === "PROGRESS" &&
              typeof progress?.progress === "number" &&
              progress.progress > 0 &&
              progress.progress < 1 &&
              typeof progress.time === "number" &&
              progress.time > 0 &&
              !controller.signal.aborted &&
              !completedBeforeAbort
            ) {
              progressObserved = true;
              abortTime = performance.now();
              controller.abort(new Error("Cancel after real encoding progress."));
            }
          };

          this.addEventListener("message", observeMessage);
        }
      }

      // Preserve the original transfer list when forwarding the request.
      return originalPostMessage.apply(this, sendArgs);
    }

    try {
      workerPrototype.postMessage = observedPostMessage;

      const outcome = await client
        .from({ kind: "bytes", bytes: source })
        .convert({
          format: "mp3",
          preset: "audio-balanced-v1",
        })
        .export(
          {
            format: "mp3",
            output: { kind: "bytes" },
          },
          {
            signal: controller.signal,
            onProgress(event) {
              stages.push(event.stage);
            },
          },
        )
        .then(
          () => ({ published: true }),
          (error) => ({
            published: false,
            code: error.code,
            jobId: error.jobId,
          }),
        );

      cancellationMilliseconds =
        abortTime === undefined ? undefined : performance.now() - abortTime;

      check(targetedExecutions === 1, "Expected exactly one targeted MP3 encoding request.");

      check(
        progressObserved && !completedBeforeAbort,
        "Encoding completed without observed intermediate progress; cancellation was not exercised.",
      );

      check(
        !outcome.published && outcome.code === "CANCELLED" && typeof outcome.jobId === "string",
        "Active encoding did not reject with CANCELLED.",
      );

      check(cancellationMilliseconds < 10000, "Cancellation took more than ten seconds to reject.");

      check(
        stages.includes("cancelled") && !stages.includes("completed"),
        "The cancelled job reported an incorrect terminal stage.",
      );
    } finally {
      workerPrototype.postMessage = originalPostMessage;

      if (observedWorker !== undefined && observeMessage !== undefined) {
        observedWorker.removeEventListener("message", observeMessage);
      }
    }

    equalBytes(source, snapshot, "Cancellation changed or detached caller input bytes.");

    // Use the same public client after cancellation and worker reset.
    const recovered = await client
      .from({ kind: "bytes", bytes: recoverySource })
      .convert({
        format: "wav",
        preset: "audio-pcm-v1",
      })
      .export({
        format: "wav",
        output: { kind: "bytes" },
      });

    check(
      recovered.output.kind === "bytes" &&
        recovered.output.bytes.length > 0 &&
        recovered.metadata.streams[0]?.codec === "pcm_s16le",
      "Same-client recovery did not produce PCM WAV.",
    );

    recoveryBytes = recovered.output.bytes;

    equalBytes(recoverySource, recoverySnapshot, "Recovery changed caller input bytes.");
  } finally {
    await client.dispose();
  }

  // Verify the exact stored PCM samples after client disposal.
  const wav = new DataView(
    recoveryBytes.buffer,
    recoveryBytes.byteOffset,
    recoveryBytes.byteLength,
  );

  function fourCC(offset) {
    return String.fromCharCode(
      recoveryBytes[offset],
      recoveryBytes[offset + 1],
      recoveryBytes[offset + 2],
      recoveryBytes[offset + 3],
    );
  }

  check(
    recoveryBytes.length >= 12 &&
      fourCC(0) === "RIFF" &&
      fourCC(8) === "WAVE" &&
      wav.getUint32(4, true) === recoveryBytes.length - 8,
    "Recovery output is not a complete RIFF WAV.",
  );

  let pcm;
  let formatChecked = false;
  let offset = 12;

  while (offset < recoveryBytes.length) {
    check(recoveryBytes.length - offset >= 8, "Recovery WAV has a truncated chunk header.");

    const kind = fourCC(offset);
    const size = wav.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    const next = end + (size & 1);

    check(next <= recoveryBytes.length, "Recovery WAV has a truncated chunk.");

    if (kind === "fmt ") {
      check(
        !formatChecked &&
          size >= 16 &&
          wav.getUint16(start, true) === 1 &&
          wav.getUint16(start + 2, true) === 2 &&
          wav.getUint32(start + 4, true) === 48000 &&
          wav.getUint32(start + 8, true) === 192000 &&
          wav.getUint16(start + 12, true) === 4 &&
          wav.getUint16(start + 14, true) === 16,
        "Recovery WAV has an unexpected PCM format.",
      );

      formatChecked = true;
    }

    if (kind === "data") {
      check(pcm === undefined, "Recovery WAV has duplicate data chunks.");
      pcm = recoveryBytes.subarray(start, end);
    }

    offset = next;
  }

  check(formatChecked && pcm !== undefined, "Recovery WAV is missing its format or sample data.");

  equalBytes(
    pcm,
    recoverySnapshot.subarray(44),
    "Recovery WAV changed the exact stored PCM source samples.",
  );

  // Independently verify that Chromium can decode the returned file.
  const decoder = new globalThis.OfflineAudioContext(2, 1, 48000);

  const decoded = await decoder.decodeAudioData(new Uint8Array(recoveryBytes).buffer);

  check(
    decoded.sampleRate === 48000 && decoded.numberOfChannels === 2 && decoded.length === 6000,
    "Recovery output decoded to an unexpected audio profile.",
  );

  const expected = new DataView(
    recoverySnapshot.buffer,
    recoverySnapshot.byteOffset,
    recoverySnapshot.byteLength,
  );

  let maxBrowserSampleDifference = 0;

  for (let channel = 0; channel < 2; channel += 1) {
    const samples = decoded.getChannelData(channel);

    for (let index = 0; index < samples.length; index += 1) {
      check(Number.isFinite(samples[index]), "Browser decoding produced a non-finite sample.");

      const original = expected.getInt16(44 + index * 4 + channel * 2, true);

      maxBrowserSampleDifference = Math.max(
        maxBrowserSampleDifference,
        Math.abs(samples[index] - original / 32768),
      );
    }
  }

  return {
    targetedExecutions,
    progressObserved,
    cancellationMilliseconds: Math.round(cancellationMilliseconds),
    decodedRecoverySamples: decoded.length,
    pcmSamplesExact: true,
    maxBrowserSampleDifference,
  };
}
