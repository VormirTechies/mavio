import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { platform } from "node:process";
import { analyzeNativeTrimSelection } from "../../dist/engines/native/trim-analysis.js";
import { buildNativeTrimFilters } from "../../dist/engines/native/trim-filters.js";
import { NativeProcessError } from "../../dist/engines/native/process.js";

const inventory = {
  encoders: ["rawvideo", "pcm_f32le"],
  decoders: [],
  muxers: ["framemd5"],
  demuxers: [],
  filters: ["trim", "settb", "setpts", "atrim", "asetpts"],
};

function options(controller = new AbortController(), hasAudio = true) {
  return {
    configuration: {
      cwd: resolve("."),
      platform: platform === "win32" ? "win32" : "posix",
    },
    tools: {
      ffmpeg: { path: resolve("ffmpeg"), version: "test" },
    },
    inventory,
    inputPath: resolve("source with spaces.mp4"),
    videoStreamIndex: 3,
    ...(hasAudio ? { audio: { streamIndex: 7, channels: 2 } } : {}),
    filters: buildNativeTrimFilters(
      { startSeconds: 0.51, endSeconds: 1.49 },
      0,
      hasAudio,
      inventory,
    ),
    context: { jobId: "trim-analysis", signal: controller.signal },
  };
}

function report(kind, populated = true) {
  return {
    stderr: "",
    stdout: [
      "#format: frame checksums",
      "#version: 2",
      "#hash: MD5",
      `#media_type 0: ${kind}`,
      `#codec_id 0: ${kind === "video" ? "rawvideo" : "pcm_f32le"}`,
      ...(populated ? ["0, 0, 0, 1, 8, 0123456789abcdef0123456789abcdef"] : []),
    ].join("\n"),
  };
}

test("analysis maps selected streams and counts stereo sample frames", async () => {
  const calls = [];
  const input = options();

  const result = await analyzeNativeTrimSelection(input, {
    run: async (request) => {
      calls.push(request);
      return report(calls.length === 1 ? "video" : "audio");
    },
  });

  assert.deepEqual(result, { videoFrames: 1, audioSamples: 1 });
  assert.ok(Object.isFrozen(result));
  assert.equal(calls.length, 2);

  for (const [index, call] of calls.entries()) {
    assert.equal(call.args[call.args.indexOf("-map") + 1], index === 0 ? "0:3" : "0:7");
    assert.equal(call.args[call.args.indexOf("-i") + 1], input.inputPath);
    assert.equal(call.args.at(-1), "pipe:1");
    assert.equal(call.maxOutputBytes, 1_048_576);
    assert.equal(call.signal, input.context.signal);
  }
});

test("analysis rejects empty video and empty required audio", async () => {
  for (const emptyKind of ["video", "audio"]) {
    let calls = 0;

    await assert.rejects(
      analyzeNativeTrimSelection(options(), {
        run: async () => {
          const kind = calls++ === 0 ? "video" : "audio";
          return report(kind, kind !== emptyKind);
        },
      }),
      (error) => {
        assert.equal(error.code, "INVALID_OPTIONS");
        assert.equal(error.details.reason, "RANGE_TOO_SHORT");
        assert.equal(error.details.streamKind, emptyKind);
        return true;
      },
    );
  }
});

test("video-only analysis launches no audio process", async () => {
  let calls = 0;

  const result = await analyzeNativeTrimSelection(options(new AbortController(), false), {
    run: async () => {
      calls++;
      return report("video");
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, { videoFrames: 1 });
});

test("cancellation prevents launch and prevents the next process", async () => {
  for (const preAborted of [true, false]) {
    const controller = new AbortController();
    if (preAborted) controller.abort();

    let calls = 0;

    await assert.rejects(
      analyzeNativeTrimSelection(options(controller), {
        run: async () => {
          calls++;
          controller.abort();
          return report("video");
        },
      }),
      { code: "CANCELLED" },
    );

    assert.equal(calls, preAborted ? 0 : 1);
  }
});

test("analysis preserves process failure causes and classifies output limits", async () => {
  for (const [reason, code] of [
    ["NONZERO_EXIT", "EXECUTION_FAILED"],
    ["OUTPUT_LIMIT", "RESOURCE_LIMIT"],
    ["CANCELLED", "CANCELLED"],
  ]) {
    const cause = new NativeProcessError(reason);

    await assert.rejects(
      analyzeNativeTrimSelection(options(), {
        run: async () => {
          throw cause;
        },
      }),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.details.reason, reason);
        assert.equal(error.cause, cause);
        return true;
      },
    );
  }
});

test("error diagnostics and missing analysis features reject", async () => {
  await assert.rejects(
    analyzeNativeTrimSelection(options(), {
      run: async () => ({ ...report("video"), stderr: "decoder error" }),
    }),
    (error) => {
      assert.equal(error.code, "EXECUTION_FAILED");
      assert.equal(error.details.reason, "TRIM_ANALYSIS_DIAGNOSTIC");
      return true;
    },
  );

  const input = options();
  let called = false;

  await assert.rejects(
    analyzeNativeTrimSelection(
      { ...input, inventory: { ...inventory, muxers: [] } },
      {
        run: async () => {
          called = true;
          return report("video");
        },
      },
    ),
    { code: "UNSUPPORTED_CAPABILITY" },
  );

  assert.equal(called, false);
});
