import assert from "node:assert/strict";
import test from "node:test";
import { buildBalancedMp4Encoding } from "../../dist/engines/native/balanced-mp4.js";

function inventory(overrides = {}) {
  return {
    encoders: ["libx264", "aac"],
    decoders: ["h264", "aac"],
    muxers: ["mp4"],
    demuxers: ["mov", "mp4"],
    filters: [],
    ...overrides,
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `Missing option: ${name}`);
  return args[index + 1];
}

test("balanced MP4 uses the approved video and audio settings", () => {
  const args = buildBalancedMp4Encoding(inventory(), true);

  assert.equal(option(args, "-c:v"), "libx264");
  assert.equal(option(args, "-crf"), "23");
  assert.equal(option(args, "-preset"), "veryfast");
  assert.equal(option(args, "-pix_fmt"), "+yuv420p");
  assert.equal(option(args, "-c:a"), "aac");
  assert.equal(option(args, "-b:a"), "128k");
  assert.equal(option(args, "-movflags"), "+faststart");
  assert.equal(option(args, "-f"), "mp4");
});

test("video-only encoding does not require AAC or synthesize audio", () => {
  const args = buildBalancedMp4Encoding(inventory({ encoders: ["libx264"] }), false);

  assert.ok(args.includes("-an"));
  assert.equal(args.includes("-c:a"), false);
  assert.equal(args.includes("-b:a"), false);
  assert.equal(args.includes("anullsrc"), false);
});

test("missing libx264 fails even when another H264 encoder exists", () => {
  assert.throws(
    () => buildBalancedMp4Encoding(inventory({ encoders: ["h264_nvenc", "aac"] }), true),
    {
      code: "UNSUPPORTED_CAPABILITY",
      stage: "preparing",
      details: {
        reason: "MISSING_ENCODER",
        component: "libx264",
        preset: "video-balanced-v1",
      },
    },
  );
});

test("missing MP4 muxer fails even when a related muxer exists", () => {
  assert.throws(() => buildBalancedMp4Encoding(inventory({ muxers: ["mov", "matroska"] }), true), {
    code: "UNSUPPORTED_CAPABILITY",
    details: {
      reason: "MISSING_MUXER",
      component: "mp4",
      preset: "video-balanced-v1",
    },
  });
});

test("selected audio requires AAC and is never silently dropped", () => {
  assert.throws(
    () => buildBalancedMp4Encoding(inventory({ encoders: ["libx264", "libmp3lame"] }), true),
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

test("encoding settings are immutable and do not impose media transformations", () => {
  const args = buildBalancedMp4Encoding(inventory(), true);

  assert.equal(Object.isFrozen(args), true);
  assert.throws(() => args.push("-extra"), TypeError);

  assert.equal(option(args, "-fps_mode:v"), "passthrough");

  for (const flag of ["-r", "-s", "-ar", "-ac", "-ss", "-t", "-to", "-shortest", "-vf", "-af"]) {
    assert.equal(args.includes(flag), false, `Unexpected option: ${flag}`);
  }

  for (const invalid of [undefined, null, 0, 1, "true"]) {
    assert.throws(() => buildBalancedMp4Encoding(inventory(), invalid), {
      code: "INVALID_OPTIONS",
    });
  }
});
