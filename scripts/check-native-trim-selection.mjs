import assert from "node:assert/strict";
import { runNativeProcess } from "../packages/mavio/dist/engines/native/process.js";
import { buildNativeTrimFilters } from "../packages/mavio/dist/engines/native/trim-filters.js";
import { validateNativeTrimSelection } from "../packages/mavio/dist/engines/native/trim-selection.js";
import { parseNativeTrimCount } from "../packages/mavio/dist/engines/native/trim-counts.js";
import { analyzeNativeTrimSelection } from "../packages/mavio/dist/engines/native/trim-analysis.js";

// This check specifically targets our two-second, 24 fps,
// 48 kHz mono fixture with a zero time origin.
export async function checkNativeTrimSelection({
  configuration,
  tools,
  inventory,
  mediaPath,
  sourceOriginSeconds,
  context,
}) {
  const filters = buildNativeTrimFilters(
    { startSeconds: 0.51, endSeconds: 1.49 },
    sourceOriginSeconds,
    true,
    inventory,
  );

  assert.ok(filters.audio);

  async function run(outputArgs) {
    const result = await runNativeProcess({
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
        ...filters.inputArgs,
        "-protocol_whitelist",
        "file",
        "-i",
        mediaPath,
        ...outputArgs,
        "pipe:1",
      ],
    });

    assert.equal(result.stderr.trim(), "");
    return result.stdout;
  }

  function frameRecords(text) {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => {
        const fields = line.split(",").map((value) => value.trim());
        assert.equal(fields.length, 6);

        const size = Number(fields[4]);
        assert.ok(Number.isSafeInteger(size) && size > 0);
        assert.match(fields[5], /^[a-f0-9]{32}$/i);

        return { size, hash: fields[5] };
      });
  }

  const videoOptions = [
    "-map",
    "0:v:0",
    "-an",
    "-c:v",
    "rawvideo",
    "-pix_fmt",
    "+yuv420p",
    "-fps_mode:v",
    "passthrough",
  ];

  const originalFrames = frameRecords(await run([...videoOptions, "-f", "framemd5"]));

  const selectedVideoReport = await run([...videoOptions, "-vf", filters.video, "-f", "framemd5"]);

  const selectedFrames = frameRecords(selectedVideoReport);

  assert.equal(originalFrames.length, 48);
  assert.equal(selectedFrames.length, 23);
  assert.deepEqual(selectedFrames, originalFrames.slice(13, 36));

  console.log("Fractional trim selects the expected source video frames.");

  const audioOptions = ["-map", "0:a:0", "-vn", "-c:a", "pcm_f32le"];

  async function audioHash(filter) {
    const text = await run([...audioOptions, "-af", filter, "-f", "hash", "-hash", "sha256"]);

    const hash = text.trim();
    assert.match(hash, /^SHA256=[a-f0-9]{64}$/i);
    return hash;
  }

  // Independent reference: count decoded samples rather than select by time.
  const referenceFilter = "atrim=start_sample=24480:end_sample=71520,asetpts=N/SR/TB";

  const actualHash = await audioHash(filters.audio);
  const referenceHash = await audioHash(referenceFilter);

  assert.equal(actualHash, referenceHash);

  // Float32 mono PCM uses four bytes per decoded sample.
  const selectedAudioReport = await run([...audioOptions, "-af", filters.audio, "-f", "framemd5"]);

  const audioFrames = frameRecords(selectedAudioReport);

  const selectedByteCount = audioFrames.reduce((total, frame) => total + frame.size, 0);

  assert.equal(selectedByteCount, (71520 - 24480) * 4);

  const videoFrames = parseNativeTrimCount(selectedVideoReport, { kind: "video" }, context.jobId);

  const audioSamples = parseNativeTrimCount(
    selectedAudioReport,
    { kind: "audio", channels: 1 },
    context.jobId,
  );

  assert.equal(videoFrames, 23);
  assert.equal(audioSamples, 47040);

  validateNativeTrimSelection({ videoFrames, audioSamples }, true, context.jobId);

  // The fixture has video frames at 0, 1/24, 2/24, ...
  // There is no video frame in [0.001, 0.002).
  const emptyFilters = buildNativeTrimFilters(
    { startSeconds: 0.001, endSeconds: 0.002 },
    sourceOriginSeconds,
    false,
    inventory,
  );

  const emptyReport = await run([...videoOptions, "-vf", emptyFilters.video, "-f", "framemd5"]);

  const emptyVideoFrames = parseNativeTrimCount(emptyReport, { kind: "video" }, context.jobId);

  assert.equal(emptyVideoFrames, 0);

  assert.throws(
    () => validateNativeTrimSelection({ videoFrames: emptyVideoFrames }, false, context.jobId),
    (error) => {
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.details.reason, "RANGE_TOO_SHORT");
      assert.equal(error.details.streamKind, "video");
      return true;
    },
  );

  console.log("Native empty-video trim rejection passed.");

  context.signal.throwIfAborted();

  console.log("Fractional trim selects the expected decoded audio samples.");

  // These indexes and channels belong to this generated fixture.
  const analysisOptions = {
    configuration,
    tools,
    inventory,
    inputPath: mediaPath,
    videoStreamIndex: 0,
    audio: { streamIndex: 1, channels: 1 },
    filters,
    context,
  };

  const analyzed = await analyzeNativeTrimSelection(analysisOptions);

  assert.deepEqual(analyzed, {
    videoFrames: 23,
    audioSamples: 47040,
  });

  await assert.rejects(
    analyzeNativeTrimSelection({
      ...analysisOptions,
      audio: undefined,
      filters: emptyFilters,
    }),
    (error) => {
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.details.reason, "RANGE_TOO_SHORT");
      assert.equal(error.details.streamKind, "video");
      return true;
    },
  );

  console.log("Native trim analysis wrapper passed.");
}
