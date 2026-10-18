import assert from "node:assert/strict";
import test from "node:test";
import { parseNativeTrimCount } from "../../dist/engines/native/trim-counts.js";
import { validateNativeTrimSelection } from "../../dist/engines/native/trim-selection.js";

const hash = "0123456789abcdef0123456789abcdef";

function report(kind, rows = []) {
  return [
    "#format: frame checksums",
    "#version: 2",
    "#hash: MD5",
    `#media_type 0: ${kind}`,
    `#codec_id 0: ${kind === "video" ? "rawvideo" : "pcm_f32le"}`,
    ...rows,
  ].join("\n");
}

test("selection counts use video records and PCM sample sizes", () => {
  const video = report("video", [`0, 0, 0, 1, 86400, ${hash}`, `0, 1, 1, 1, 86400, ${hash}`]);

  const audio = report("audio", [`0, 0, 0, 1024, 4096, ${hash}`, `0, 1024, 1024, 16, 64, ${hash}`]);

  assert.equal(parseNativeTrimCount(video, { kind: "video" }), 2);
  assert.equal(parseNativeTrimCount(audio, { kind: "audio", channels: 1 }), 1040);
});

test("valid empty output becomes RANGE_TOO_SHORT", () => {
  const videoFrames = parseNativeTrimCount(report("video"), { kind: "video" });

  assert.equal(videoFrames, 0);

  assert.throws(
    () => validateNativeTrimSelection({ videoFrames }, false),
    (error) => {
      assert.equal(error.code, "INVALID_OPTIONS");
      assert.equal(error.details.reason, "RANGE_TOO_SHORT");
      return true;
    },
  );
});

test("missing or mismatched headers are not treated as empty selection", () => {
  for (const text of [
    "",
    "unrecognized output",
    report("audio"),
    report("video").replace("#hash: MD5", "#hash: SHA256"),
    `${report("video")}\n#media_type 1: audio`,
  ]) {
    assert.throws(
      () => parseNativeTrimCount(text, { kind: "video" }, "selection-job"),
      (error) => {
        assert.equal(error.code, "EXECUTION_FAILED");
        assert.equal(error.details.reason, "INVALID_TRIM_SELECTION");
        assert.equal(error.jobId, "selection-job");
        return true;
      },
    );
  }
});

test("malformed frame records reject instead of producing partial counts", () => {
  for (const row of [
    `1, 0, 0, 1, 100, ${hash}`,
    `0, 0, 0, 1, 0, ${hash}`,
    `0, 0, 0, -1, 100, ${hash}`,
    `0, 0, 0, 1, 1.5, ${hash}`,
    `0, 0, 0, 1, 9007199254740992, ${hash}`,
    "0, 0, 0, 1, 100, invalid-hash",
    "truncated",
  ]) {
    assert.throws(
      () =>
        parseNativeTrimCount(report("video", [`0, 0, 0, 1, 100, ${hash}`, row]), { kind: "video" }),
      { code: "EXECUTION_FAILED" },
    );
  }
});

test("stereo PCM counts sample frames and rejects incomplete samples", () => {
  assert.equal(
    parseNativeTrimCount(report("audio", [`0, 0, 0, 1024, 8192, ${hash}`]), {
      kind: "audio",
      channels: 2,
    }),
    1024,
  );

  assert.throws(
    () =>
      parseNativeTrimCount(report("audio", [`0, 0, 0, 1, 4, ${hash}`]), {
        kind: "audio",
        channels: 2,
      }),
    { code: "EXECUTION_FAILED" },
  );
});
