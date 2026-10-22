import { createMavio } from "/mavio.mjs";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function createWav() {
  const sampleRate = 48_000;
  const samples = 4_800;
  const dataBytes = samples * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);

  function text(offset, value) {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  }

  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let index = 0; index < samples; index += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 10_000);

    view.setInt16(44 + index * 2, sample, true);
  }

  return bytes;
}

export async function runBrowserMetadataSmoke(origin) {
  const bytes = createWav();
  const snapshot = bytes.slice();
  const blob = new Blob([bytes], { type: "audio/wav" });
  const file = new File([bytes], "fixture with spaces.wav", {
    type: "audio/wav",
  });

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

  function validate(metadata) {
    check(metadata.container === "wav", "Expected the WAV container.");
    check(metadata.sizeBytes === snapshot.byteLength, "Wrong input size.");
    check(Math.abs(metadata.durationSeconds - 0.1) < 0.000001, "Wrong WAV duration.");
    check(metadata.streams.length === 1, "Expected one audio stream.");

    const audio = metadata.streams[0];

    check(audio.kind === "audio", "Expected an audio stream.");
    check(audio.codec === "pcm_s16le", "Wrong WAV codec.");
    check(audio.sampleRate === 48_000, "Wrong sample rate.");
    check(audio.channels === 1, "Wrong channel count.");
  }

  try {
    const capabilities = await client.capabilities();

    check(capabilities.operations.includes("metadata"), "Metadata capability is missing.");

    for (const input of [
      { kind: "bytes", bytes, name: "../../caller-name.wav" },
      { kind: "blob", blob },
      { kind: "blob", blob: file },
    ]) {
      validate(await client.from(input).metadata());
    }

    check(
      bytes.byteLength === snapshot.byteLength &&
        bytes.every((value, index) => value === snapshot[index]),
      "Caller bytes changed or became detached.",
    );

    for (const source of [blob, file]) {
      const retained = new Uint8Array(await source.arrayBuffer());

      check(
        retained.length === snapshot.length &&
          retained.every((value, index) => value === snapshot[index]),
        "Caller Blob or File content changed.",
      );
    }

    let invalidCode;

    try {
      await client
        .from({
          kind: "bytes",
          bytes: new TextEncoder().encode("This is not a media file."),
        })
        .metadata();

      invalidCode = "UNEXPECTED_SUCCESS";
    } catch (error) {
      invalidCode = error.code;
    }

    check(invalidCode === "INVALID_MEDIA", `Expected INVALID_MEDIA; received ${invalidCode}.`);

    const recovered = await client
      .from({
        kind: "bytes",
        bytes,
      })
      .metadata();

    validate(recovered);

    // Mutating one response must not affect subsequent metadata.
    recovered.streams[0].sampleRate = 1;

    const independent = await client
      .from({
        kind: "blob",
        blob,
      })
      .metadata();

    validate(independent);

    await client.dispose();

    check(
      bytes.byteLength === snapshot.byteLength &&
        bytes.every((value, index) => value === snapshot[index]),
      "Caller bytes changed after client disposal.",
    );

    return {
      inputKindsChecked: ["bytes", "Blob", "File"],
      durationSeconds: independent.durationSeconds,
      sizeBytes: independent.sizeBytes,
      codec: independent.streams[0].codec,
      sampleRate: independent.streams[0].sampleRate,
      invalidCode,
    };
  } finally {
    await client.dispose();
  }
}
