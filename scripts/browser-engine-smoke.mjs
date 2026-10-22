import { FFmpeg } from "/wrapper/index.js";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

export async function runBrowserEngineSmoke(origin) {
  const engine = new FFmpeg();
  const logs = [];

  engine.on("log", ({ message }) => {
    logs.push(message);
    if (logs.length > 30) logs.shift();
  });

  const configuration = {
    classWorkerURL: new URL("/wrapper/worker.js", origin).href,
    coreURL: new URL("/core/ffmpeg-core.js", origin).href,
    wasmURL: new URL("/core/ffmpeg-core.wasm", origin).href,
  };

  let probeNumber = 0;

  async function probe(input) {
    const output = `probe-${++probeNumber}.json`;
    const before = await engine.listDir("/");

    check(!before.some((entry) => entry.name === output), "Probe output must be fresh.");

    const exitCode = await engine.ffprobe(
      [
        "-v",
        "error",
        "-show_error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        input,
        "-o",
        output,
      ],
      30_000,
    );

    const after = await engine.listDir("/");
    const exists = after.some((entry) => entry.name === output);

    if (!exists) return { exitCode, report: null };

    try {
      const text = await engine.readFile(output, "utf8");
      return { exitCode, report: JSON.parse(text) };
    } finally {
      await engine.deleteFile(output);
    }
  }

  function validateProbe({ exitCode, report }) {
    // This exception is specific to the pinned core's observed ffprobe behavior.
    // A nonzero return alone never establishes successful probing.
    check(exitCode === 0 || exitCode === -1, `Unexpected ffprobe exit code: ${exitCode}`);
    check(report && !report.error, "Probe did not return valid media.");
    check(report.format && typeof report.format === "object", "Probe format is missing.");
    check(Array.isArray(report.streams) && report.streams.length > 0, "Probe streams are missing.");

    return report;
  }

  try {
    check(!engine.loaded, "Engine unexpectedly started loaded.");

    await engine.load(configuration);
    check(engine.loaded, "Browser engine did not load.");

    const initialEntries = await engine.listDir("/");

    check(
      !initialEntries.some((entry) => entry.name === "fixture.wav"),
      "Fixture output already exists.",
    );

    const exitCode = await engine.exec(
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=0.1",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        "fixture.wav",
      ],
      30_000,
    );

    check(exitCode === 0, `Fixture encoding failed: ${exitCode}`);

    const validProbe = await probe("fixture.wav");
    const metadata = validateProbe(validProbe);
    const audio = metadata.streams.filter((stream) => stream.codec_type === "audio");

    check(audio.length === 1, "Expected exactly one audio stream.");
    check(audio[0].codec_name === "pcm_s16le", "Unexpected audio codec.");
    check(Number(audio[0].sample_rate) === 48_000, "Unexpected sample rate.");
    check(Math.abs(Number(metadata.format.duration) - 0.1) < 0.001, "Unexpected fixture duration.");

    const outputBytes = await engine.readFile("fixture.wav");
    check(outputBytes instanceof Uint8Array, "Expected binary output.");
    check(outputBytes.byteLength > 44, "Generated WAV is too small.");
    const snapshot = outputBytes.slice();

    const invalidBytes = new TextEncoder().encode("This is not media.");
    // writeFile transfers its buffer; preserve caller ownership with a copy.
    await engine.writeFile("invalid.bin", invalidBytes.slice());

    const invalidProbe = await probe("invalid.bin");

    check(
      invalidProbe.report?.error || (invalidProbe.report === null && invalidProbe.exitCode !== 0),
      "Invalid media did not produce an explicit probe failure.",
    );

    // A rejected probe must not prevent subsequent valid work.
    validateProbe(await probe("fixture.wav"));

    engine.terminate();
    check(!engine.loaded, "Termination did not reset the loaded state.");

    let rejectedAfterTermination = false;

    try {
      await engine.exec(["-version"]);
    } catch {
      rejectedAfterTermination = true;
    }

    check(rejectedAfterTermination, "Execution after termination should reject until reloaded.");

    await engine.load(configuration);
    check(engine.loaded, "Browser engine did not reload.");

    const entries = await engine.listDir("/");

    check(
      !entries.some((entry) => entry.name === "fixture.wav" || entry.name === "invalid.bin"),
      "Reload retained files from the terminated worker.",
    );

    check(
      outputBytes.byteLength === snapshot.byteLength &&
        outputBytes.every((value, index) => value === snapshot[index]),
      "Returned bytes changed after termination and reload.",
    );

    return {
      probeExitCode: validProbe.exitCode,
      sampleRate: Number(audio[0].sample_rate),
      durationSeconds: Number(metadata.format.duration),
      outputBytes: outputBytes.byteLength,
    };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `Recent engine logs:\n${logs.join("\n")}`,
      { cause: error },
    );
  } finally {
    engine.terminate();
  }
}
