import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserMp4Encoding } from "../../dist/engines/browser/mp4-encoding.js";
import { buildNativeMp4Encoding } from "../../dist/engines/native/mp4-encoding.js";

function inventory() {
  return {
    encoders: ["libx264", "aac"],
    decoders: ["h264", "aac"],
    muxers: ["mp4"],
    demuxers: ["mov", "mp4"],
    filters: [],
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `Missing option ${name}`);
  return args[index + 1];
}

test("browser MP4 presets retain the shared native encoding settings", () => {
  for (const preset of ["video-balanced-v1", "video-small-v1"]) {
    for (const hasAudio of [false, true]) {
      const source = inventory();
      const native = buildNativeMp4Encoding(preset, source, hasAudio);
      const browser = buildBrowserMp4Encoding(preset, source, hasAudio);

      assert.deepEqual(browser.slice(0, native.length), native);

      assert.equal(option(browser, "-threads:v"), "1");

      if (hasAudio) {
        assert.equal(option(browser, "-threads:a"), "1");
      } else {
        assert.equal(browser.includes("-threads:a"), false);
      }

      assert.equal(Object.isFrozen(browser), true);
    }
  }
});

test("browser balanced and small presets use their approved quality settings", () => {
  const balanced = buildBrowserMp4Encoding("video-balanced-v1", inventory(), true);

  const small = buildBrowserMp4Encoding("video-small-v1", inventory(), true);

  assert.equal(option(balanced, "-crf"), "23");
  assert.equal(option(balanced, "-b:a"), "128k");
  assert.equal(option(small, "-crf"), "28");
  assert.equal(option(small, "-b:a"), "96k");

  for (const args of [balanced, small]) {
    assert.equal(option(args, "-c:v"), "libx264");
    assert.equal(option(args, "-c:a"), "aac");
    assert.equal(option(args, "-preset"), "veryfast");
    assert.equal(option(args, "-pix_fmt"), "+yuv420p");
    assert.equal(option(args, "-fps_mode:v"), "passthrough");
    assert.equal(option(args, "-movflags"), "+faststart");
    assert.equal(option(args, "-f"), "mp4");
  }
});

test("video-only browser encoding does not require or add an audio encoder", () => {
  const available = inventory();
  available.encoders = ["libx264"];

  const args = buildBrowserMp4Encoding("video-balanced-v1", available, false);

  assert.ok(args.includes("-an"));
  assert.equal(args.includes("-c:a"), false);
  assert.equal(args.includes("-b:a"), false);

  assert.throws(() => buildBrowserMp4Encoding("video-balanced-v1", available, true), {
    code: "UNSUPPORTED_CAPABILITY",
    details: {
      reason: "MISSING_ENCODER",
      component: "aac",
      preset: "video-balanced-v1",
    },
  });
});

test("browser MP4 encoding rejects missing required build components", () => {
  for (const preset of ["video-balanced-v1", "video-small-v1"]) {
    const noMuxer = inventory();
    noMuxer.muxers = [];

    assert.throws(() => buildBrowserMp4Encoding(preset, noMuxer, false), {
      code: "UNSUPPORTED_CAPABILITY",
      details: {
        reason: "MISSING_MUXER",
        component: "mp4",
        preset,
      },
    });

    const noVideoEncoder = inventory();
    noVideoEncoder.encoders = ["aac"];

    assert.throws(() => buildBrowserMp4Encoding(preset, noVideoEncoder, false), {
      code: "UNSUPPORTED_CAPABILITY",
      details: {
        reason: "MISSING_ENCODER",
        component: "libx264",
        preset,
      },
    });
  }
});

test("browser encoding settings contain no input or overwrite arguments", () => {
  const available = inventory();
  const before = structuredClone(available);

  const args = buildBrowserMp4Encoding("video-balanced-v1", available, true);

  for (const flag of ["-i", "-y", "-n", "-nostdin"]) {
    assert.equal(args.includes(flag), false);
  }

  assert.deepEqual(available, before);
});
