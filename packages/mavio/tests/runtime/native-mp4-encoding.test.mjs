import assert from "node:assert/strict";
import test from "node:test";
import { buildNativeMp4Encoding } from "../../dist/engines/native/mp4-encoding.js";

function inventory(overrides = {}) {
  return {
    encoders: ["libx264", "aac"],
    decoders: [],
    muxers: ["mp4"],
    demuxers: [],
    filters: [],
    ...overrides,
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `Missing option: ${name}`);
  return args[index + 1];
}

test("small MP4 uses its approved encoding settings", () => {
  const args = buildNativeMp4Encoding("video-small-v1", inventory(), true);

  assert.equal(option(args, "-c:v"), "libx264");
  assert.equal(option(args, "-crf"), "28");
  assert.equal(option(args, "-preset"), "veryfast");
  assert.equal(option(args, "-pix_fmt"), "+yuv420p");
  assert.equal(option(args, "-fps_mode:v"), "passthrough");
  assert.equal(option(args, "-c:a"), "aac");
  assert.equal(option(args, "-b:a"), "96k");
  assert.equal(option(args, "-movflags"), "+faststart");
  assert.equal(option(args, "-f"), "mp4");
});

test("small video-only encoding does not require or introduce audio", () => {
  const args = buildNativeMp4Encoding(
    "video-small-v1",
    inventory({ encoders: ["libx264"] }),
    false,
  );

  assert.ok(args.includes("-an"));
  assert.equal(args.includes("-c:a"), false);
  assert.equal(args.includes("-b:a"), false);
});

test("small preset requires its exact encoders and muxer", () => {
  for (const [overrides, component, reason] of [
    [{ encoders: ["h264_nvenc", "aac"] }, "libx264", "MISSING_ENCODER"],
    [{ encoders: ["libx264"] }, "aac", "MISSING_ENCODER"],
    [{ muxers: ["mov"] }, "mp4", "MISSING_MUXER"],
  ]) {
    assert.throws(
      () => buildNativeMp4Encoding("video-small-v1", inventory(overrides), true),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
        assert.deepEqual(error.details, {
          reason,
          component,
          preset: "video-small-v1",
        });
        return true;
      },
    );
  }
});

test("shared encoding settings reject invalid inputs and add no transformations", () => {
  for (const preset of ["video-balanced-v1", "video-small-v1"]) {
    const args = buildNativeMp4Encoding(preset, inventory(), true);

    assert.ok(Object.isFrozen(args));
    assert.throws(() => args.push("-extra"), TypeError);

    for (const flag of ["-r", "-s", "-ar", "-ac", "-ss", "-t", "-to", "-shortest", "-vf", "-af"]) {
      assert.equal(args.includes(flag), false);
    }

    for (const hasAudio of [undefined, null, 0, "true"]) {
      assert.throws(() => buildNativeMp4Encoding(preset, inventory(), hasAudio), {
        code: "INVALID_OPTIONS",
      });
    }
  }

  for (const preset of [undefined, null, "unknown", "audio-balanced-v1"]) {
    assert.throws(() => buildNativeMp4Encoding(preset, inventory(), true), {
      code: "INVALID_OPTIONS",
    });
  }
});
