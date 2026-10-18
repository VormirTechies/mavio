import assert from "node:assert/strict";
import test from "node:test";
import { captureNativeConfiguration } from "../../dist/engines/native/config.js";

const windows = () => ({
  cwd: "D:\\Project",
  path: "C:\\Tools;D:\\Media Tools",
  platform: "win32",
});

const unix = () => ({
  cwd: "/project",
  path: "/usr/local/bin:/usr/bin",
  platform: "posix",
});

test("native configuration generates platform-specific executable candidates", () => {
  const win = captureNativeConfiguration({}, windows());

  assert.deepEqual(win.ffmpegCandidates, ["C:\\Tools\\ffmpeg.exe", "D:\\Media Tools\\ffmpeg.exe"]);
  assert.deepEqual(win.ffprobeCandidates, [
    "C:\\Tools\\ffprobe.exe",
    "D:\\Media Tools\\ffprobe.exe",
  ]);

  const posix = captureNativeConfiguration({}, unix());

  assert.deepEqual(posix.ffmpegCandidates, ["/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]);
  assert.deepEqual(posix.ffprobeCandidates, ["/usr/local/bin/ffprobe", "/usr/bin/ffprobe"]);
});

test("native configuration rejects malformed option objects and values", () => {
  for (const value of [null, [], 42, "invalid"]) {
    assert.throws(() => captureNativeConfiguration(value, windows()), {
      code: "INVALID_OPTIONS",
      stage: "queued",
    });
  }

  for (const value of [null, 42, "", "C:\\Tools\\bad\0.exe"]) {
    assert.throws(() => captureNativeConfiguration({ ffmpegPath: value }, windows()), {
      code: "INVALID_OPTIONS",
      details: { reason: "INVALID_BINARY_PATH", tool: "ffmpeg" },
    });
  }
});

test("explicit overrides remain independent and never gain PATH fallbacks", () => {
  const result = captureNativeConfiguration(
    { ffmpegPath: "E:\\Custom Tools\\ffmpeg.exe" },
    windows(),
  );

  assert.deepEqual(result.ffmpegCandidates, ["E:\\Custom Tools\\ffmpeg.exe"]);
  assert.deepEqual(result.ffprobeCandidates, [
    "C:\\Tools\\ffprobe.exe",
    "D:\\Media Tools\\ffprobe.exe",
  ]);

  const both = captureNativeConfiguration(
    {
      ffmpegPath: "/custom/ffmpeg",
      ffprobePath: "/other/ffprobe",
    },
    unix(),
  );

  assert.deepEqual(both.ffmpegCandidates, ["/custom/ffmpeg"]);
  assert.deepEqual(both.ffprobeCandidates, ["/other/ffprobe"]);
});

test("relative overrides and Windows shell wrappers are rejected", () => {
  for (const value of [
    "ffprobe.exe",
    ".\\ffprobe.exe",
    "C:ffprobe.exe",
    "\\Tools\\ffprobe.exe",
    "C:\\Tools\\ffprobe.cmd",
    "C:\\Tools\\ffprobe.BAT",
  ]) {
    assert.throws(() => captureNativeConfiguration({ ffprobePath: value }, windows()), {
      code: "INVALID_OPTIONS",
    });
  }

  assert.throws(() => captureNativeConfiguration({ ffmpegPath: "./bin/ffmpeg" }, unix()), {
    code: "INVALID_OPTIONS",
  });
});

test("PATH filtering preserves explicit directory order without implicit cwd", () => {
  const result = captureNativeConfiguration(
    {},
    {
      ...windows(),
      path: ";.;relative;C:relative;\\rooted;D:\\Project;C:\\Tools;",
    },
  );

  assert.deepEqual(result.searchDirectories, ["D:\\Project", "C:\\Tools"]);
  assert.deepEqual(result.ffmpegCandidates, ["D:\\Project\\ffmpeg.exe", "C:\\Tools\\ffmpeg.exe"]);

  const empty = captureNativeConfiguration({}, { ...unix(), path: "" });

  assert.deepEqual(empty.searchDirectories, []);
  assert.deepEqual(empty.ffmpegCandidates, []);
  assert.deepEqual(empty.ffprobeCandidates, []);
});

test("native configuration captures immutable options and environment values", () => {
  const environment = windows();
  const options = { ffmpegPath: "E:\\Original\\ffmpeg.exe" };
  const result = captureNativeConfiguration(options, environment);

  options.ffmpegPath = "E:\\Changed\\ffmpeg.exe";
  environment.cwd = "D:\\Changed";
  environment.path = "D:\\Changed";
  environment.platform = "posix";

  assert.equal(result.cwd, "D:\\Project");
  assert.equal(result.platform, "win32");
  assert.deepEqual(result.ffmpegCandidates, ["E:\\Original\\ffmpeg.exe"]);
  assert.deepEqual(result.searchDirectories, ["C:\\Tools", "D:\\Media Tools"]);

  for (const value of [
    result,
    result.searchDirectories,
    result.ffmpegCandidates,
    result.ffprobeCandidates,
  ]) {
    assert.ok(Object.isFrozen(value));
  }
});
