import assert from "node:assert/strict";
import { resolve } from "node:path";
import { platform } from "node:process";
import test from "node:test";
import { analyzeNativeAudioTrim } from "../../dist/engines/native/audio-trim-analysis.js";
import { buildNativeAudioTrimFilters } from "../../dist/engines/native/audio-trim-filters.js";
import { NativeProcessError } from "../../dist/engines/native/process.js";

function options(controller = new AbortController()) {
  const inventory = {
    encoders: ["pcm_f32le"],
    decoders: [],
    muxers: ["framemd5"],
    demuxers: [],
    filters: ["atrim", "asetpts"],
  };

  return {
    configuration: {
      cwd: resolve("."),
      platform: platform === "win32" ? "win32" : "posix",
    },
    tools: {
      ffmpeg: { path: resolve("ffmpeg"), version: "test" },
    },
    inventory,
    inputPath: resolve("source audio.flac"),
    streamIndex: 7,
    channels: 2,
    filters: buildNativeAudioTrimFilters({ startSeconds: 0.51, endSeconds: 1.49 }, 0, inventory),
    context: {
      jobId: "audio-trim-analysis-test",
      signal: controller.signal,
    },
  };
}

function report(populated = true) {
  return {
    stderr: "",
    stdout: [
      "#format: frame checksums",
      "#version: 2",
      "#hash: MD5",
      "#media_type 0: audio",
      "#codec_id 0: pcm_f32le",
      ...(populated ? ["0, 0, 0, 2, 16, 0123456789abcdef0123456789abcdef"] : []),
    ].join("\n"),
  };
}

test("audio trim analysis maps one stream and counts samples per channel", async () => {
  const input = options();
  const calls = [];

  const result = await analyzeNativeAudioTrim(input, {
    async run(request) {
      calls.push(request);
      return report();
    },
  });

  assert.deepEqual(result, { audioSamples: 2 });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(calls.length, 1);

  const call = calls[0];
  assert.equal(call.args[call.args.indexOf("-map") + 1], "0:7");
  assert.equal(call.args[call.args.indexOf("-af") + 1], input.filters.audio);
  assert.equal(call.args[call.args.indexOf("-i") + 1], input.inputPath);
  assert.equal(call.args.at(-1), "pipe:1");
  assert.equal(call.maxOutputBytes, 1_048_576);
  assert.equal(call.signal, input.context.signal);
  assert.equal(call.args.includes("-copyts"), true);
  assert.equal(call.args.includes("-vf"), false);
});

test("audio trim analysis rejects an empty selected interval", async () => {
  await assert.rejects(
    analyzeNativeAudioTrim(options(), {
      run: async () => report(false),
    }),
    {
      code: "INVALID_OPTIONS",
      operation: "trim",
      details: { reason: "RANGE_TOO_SHORT", streamKind: "audio" },
    },
  );
});

test("audio trim analysis rejects malformed reports and error diagnostics", async () => {
  for (const [result, reason] of [
    [{ stdout: "invalid", stderr: "" }, "INVALID_TRIM_SELECTION"],
    [{ ...report(), stderr: "Decoding failed" }, "TRIM_ANALYSIS_DIAGNOSTIC"],
  ]) {
    await assert.rejects(
      analyzeNativeAudioTrim(options(), {
        run: async () => result,
      }),
      { code: "EXECUTION_FAILED", details: { reason } },
    );
  }
});

test("audio trim analysis requires its diagnostic encoder and muxer", async () => {
  for (const field of ["encoders", "muxers"]) {
    const input = options();
    input.inventory[field] = [];
    let launches = 0;

    await assert.rejects(
      analyzeNativeAudioTrim(input, {
        async run() {
          launches++;
          return report();
        },
      }),
      {
        code: "UNSUPPORTED_CAPABILITY",
        details: { reason: "MISSING_TRIM_ANALYSIS_FEATURE" },
      },
    );

    assert.equal(launches, 0);
  }
});

test("audio trim analysis rejects invalid paths, indexes and channel counts", async () => {
  for (const changes of [
    { inputPath: "relative.flac" },
    { streamIndex: -1 },
    { streamIndex: 1.5 },
    { channels: 0 },
    { channels: 6 },
  ]) {
    let launches = 0;

    await assert.rejects(
      analyzeNativeAudioTrim(
        { ...options(), ...changes },
        {
          async run() {
            launches++;
            return report();
          },
        },
      ),
      {
        code: "INVALID_OPTIONS",
        details: { reason: "INVALID_TRIM_ANALYSIS_OPTIONS" },
      },
    );

    assert.equal(launches, 0);
  }
});

test("audio trim analysis honors cancellation and preserves process failures", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Stopped"));
  let launches = 0;

  await assert.rejects(
    analyzeNativeAudioTrim(options(controller), {
      async run() {
        launches++;
        return report();
      },
    }),
    { code: "CANCELLED" },
  );

  assert.equal(launches, 0);

  for (const [reason, code] of [
    ["CANCELLED", "CANCELLED"],
    ["OUTPUT_LIMIT", "RESOURCE_LIMIT"],
    ["NONZERO_EXIT", "EXECUTION_FAILED"],
  ]) {
    const failure = new NativeProcessError(reason, {});

    await assert.rejects(
      analyzeNativeAudioTrim(options(), {
        async run() {
          throw failure;
        },
      }),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.cause, failure);
        assert.equal(error.details.reason, reason);
        return true;
      },
    );
  }
});
