import assert from "node:assert/strict";
import test from "node:test";
import { selectNativeMp4Streams } from "../../dist/engines/native/mp4-streams.js";
import { buildBalancedMp4Encoding } from "../../dist/engines/native/balanced-mp4.js";

function inventory(encoders) {
  return {
    encoders,
    decoders: [],
    muxers: ["mp4"],
    demuxers: [],
    filters: [],
  };
}

test("MP4 selection preserves absolute indexes and omits additional streams", () => {
  const selected = selectNativeMp4Streams({
    streams: [
      { index: 0, kind: "subtitle", codec: "subrip" },
      { index: 2, kind: "video", codec: "h264" },
      { index: 5, kind: "audio", codec: "aac" },
      { index: 7, kind: "video", codec: "h264" },
      { index: 9, kind: "audio", codec: "aac" },
      { index: 12, kind: "other" },
    ],
  });

  assert.deepEqual(selected, {
    videoStreamIndex: 2,
    audioStreamIndex: 5,
  });
});

test("video-only selection builds encoding settings without requiring AAC", () => {
  const selected = selectNativeMp4Streams({
    streams: [
      { index: 3, kind: "video", codec: "h264" },
      { index: 8, kind: "subtitle", codec: "subrip" },
    ],
  });

  assert.deepEqual(selected, { videoStreamIndex: 3 });

  const args = buildBalancedMp4Encoding(
    inventory(["libx264"]),
    selected.audioStreamIndex !== undefined,
  );

  assert.ok(args.includes("-an"));
  assert.equal(args.includes("-c:a"), false);
});

test("audio at index zero is retained and still requires the AAC encoder", () => {
  const selected = selectNativeMp4Streams({
    streams: [
      { index: 0, kind: "audio", codec: "aac" },
      { index: 4, kind: "video", codec: "h264" },
    ],
  });

  assert.equal(selected.audioStreamIndex, 0);

  assert.throws(
    () => buildBalancedMp4Encoding(inventory(["libx264"]), selected.audioStreamIndex !== undefined),
    {
      code: "UNSUPPORTED_CAPABILITY",
      details: {
        reason: "MISSING_ENCODER",
        component: "aac",
        preset: "video-balanced-v1",
      },
    },
  );
});

test("missing video is rejected and successful selections are independent snapshots", () => {
  for (const streams of [
    [],
    [{ index: 0, kind: "audio", codec: "aac" }],
    [{ index: 0, kind: "subtitle", codec: "subrip" }],
  ]) {
    assert.throws(() => selectNativeMp4Streams({ streams }), {
      code: "INVALID_MEDIA",
      details: { reason: "MISSING_VIDEO" },
    });
  }

  const source = {
    streams: [
      { index: 0, kind: "video", codec: "h264" },
      { index: 1, kind: "audio", codec: "aac" },
    ],
  };

  const selected = selectNativeMp4Streams(source);
  source.streams[0].index = 10;
  source.streams[1].index = 11;

  assert.deepEqual(selected, {
    videoStreamIndex: 0,
    audioStreamIndex: 1,
  });

  assert.equal(Object.isFrozen(selected), true);
});
