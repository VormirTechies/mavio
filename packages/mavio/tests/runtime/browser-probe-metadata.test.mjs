import assert from "node:assert/strict";
import test from "node:test";
import { parseBrowserProbeMetadata } from "../../dist/engines/browser/probe-metadata.js";

function report() {
  return {
    format: {
      duration: "0.100000",
      size: "9678",
      format_name: "wav",
      bit_rate: "774240",
    },
    streams: [
      {
        index: 0,
        codec_type: "audio",
        codec_name: "pcm_s16le",
        sample_rate: "48000",
        channels: 1,
      },
    ],
  };
}

function parse(value, exitCode = 0) {
  return parseBrowserProbeMetadata(JSON.stringify(value), exitCode, "browser-probe-test");
}

test("browser probe maps structured audio metadata", () => {
  assert.deepEqual(parse(report()), {
    durationSeconds: 0.1,
    sizeBytes: 9678,
    container: "wav",
    bitrateBitsPerSecond: 774240,
    streams: [
      {
        index: 0,
        kind: "audio",
        codec: "pcm_s16le",
        sampleRate: 48000,
        channels: 1,
      },
    ],
  });
});

test("the pinned browser probe permits -1 only with valid metadata", () => {
  assert.deepEqual(parse(report(), -1), parse(report(), 0));

  for (const value of [{}, { format: {}, streams: [] }, { streams: report().streams }]) {
    assert.throws(() => parse(value, -1), {
      code: "EXECUTION_FAILED",
    });
  }
});

test("browser probe rejects other exit codes despite plausible metadata", () => {
  for (const code of [1, 2, -2, NaN, Infinity, undefined, "0"]) {
    assert.throws(
      () => parseBrowserProbeMetadata(JSON.stringify(report()), code, "browser-probe-test"),
      {
        code: "EXECUTION_FAILED",
        details: { reason: "PROBE_EXIT_FAILURE" },
      },
    );
  }
});

test("explicit probe errors reject media even alongside plausible metadata", () => {
  const value = {
    ...report(),
    error: {
      code: -1094995529,
      string: "Invalid data found when processing input",
    },
  };

  for (const exitCode of [0, -1, 1]) {
    assert.throws(() => parse(value, exitCode), {
      code: "INVALID_MEDIA",
      stage: "preparing",
      jobId: "browser-probe-test",
      details: { reason: "PROBE_REJECTED_MEDIA" },
    });
  }
});

test("malformed browser probe JSON does not expose source text", () => {
  const marker = "PRIVATE_MEDIA_MARKER";

  assert.throws(
    () => parseBrowserProbeMetadata(`{"streams": ${marker}`, -1, "browser-probe-test"),
    (error) => {
      assert.equal(error.code, "EXECUTION_FAILED");
      assert.equal(error.details.reason, "INVALID_PROBE_RESPONSE");
      assert.equal(error.message.includes(marker), false);
      assert.equal(error.cause, undefined);
      return true;
    },
  );

  for (const value of [null, [], 42, "text"]) {
    assert.throws(() => parse(value), {
      code: "EXECUTION_FAILED",
    });
  }
});

test("browser probe requires a format object and nonempty streams", () => {
  for (const value of [
    { streams: report().streams },
    { format: null, streams: report().streams },
    { format: [], streams: report().streams },
    { format: {}, streams: [] },
    { format: {} },
  ]) {
    assert.throws(() => parse(value), {
      code: "EXECUTION_FAILED",
    });
  }
});

test("browser probe retains shared stream validation and video mapping", () => {
  const value = {
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
    streams: [
      {
        index: 0,
        codec_type: "video",
        codec_name: "h264",
        width: 320,
        height: 180,
        avg_frame_rate: "24000/1001",
        tags: { rotate: "90" },
      },
    ],
  };

  const video = parse(value).streams[0];

  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  assert.equal(video.rotationDegrees, 90);
  assert.deepEqual(video.frameRate, {
    numerator: 24000,
    denominator: 1001,
  });

  value.streams.push({ ...value.streams[0] });

  assert.throws(() => parse(value), {
    code: "EXECUTION_FAILED",
  });
});

test("malformed probe error objects are engine response failures", () => {
  for (const error of [
    null,
    [],
    "invalid",
    {},
    { code: 0, string: "invalid" },
    { code: "-1", string: "invalid" },
    { code: -1 },
  ]) {
    assert.throws(() => parse({ ...report(), error }), {
      code: "EXECUTION_FAILED",
      details: {
        reason: "INVALID_PROBE_RESPONSE",
        tool: "ffprobe",
        field: "$.error",
      },
    });
  }
});
