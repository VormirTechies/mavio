import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { createMavio } from "../packages/mavio/dist/node.js";
import { createNativeEngine } from "../packages/mavio/dist/engines/native/adapter.js";

function run(binary, args) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, "Tool terminated by a signal.");
  assert.equal(result.status, 0, result.stderr || "Tool failed.");
  assert.equal(result.stderr.trim(), "", "Unexpected tool error diagnostics.");
  return result.stdout;
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 0 || args.length === 2,
    "Provide no arguments or absolute FFmpeg and FFprobe paths.",
  );
  if (args.length === 2) assert.ok(args.every(isAbsolute));

  const [ffmpeg = "ffmpeg", ffprobe = "ffprobe"] = args;
  const directory = await mkdtemp(join(tmpdir(), "mavio-compression-"));
  const fixtures = [];
  const retained = [];
  const results = [];

  console.log(
    "Native compression: " + process.version + ", " + process.platform + "/" + process.arch,
  );

  try {
    for (const audio of [false, true]) {
      const path = join(directory, audio ? "source-av.mp4" : "source-video.mp4");
      const command = [
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=12:duration=0.5",
      ];

      if (audio) {
        command.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.5");
      }

      command.push("-map", "0:v:0");
      if (audio) {
        command.push("-map", "1:a:0", "-c:a", "aac", "-ar", "48000", "-ac", "1", "-threads:a", "1");
      } else {
        command.push("-an");
      }

      command.push(
        "-vf",
        "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-threads:v",
        "1",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        "-color_range",
        "tv",
        "-f",
        "mp4",
        path,
      );

      run(ffmpeg, command);
      const fixtureReport = JSON.parse(
        run(ffprobe, ["-v", "error", "-show_streams", "-of", "json", path]),
      );
      const fixtureVideo = fixtureReport.streams.find((stream) => stream.codec_type === "video");

      console.log("Compression fixture color profile:", {
        audio,
        pixelFormat: fixtureVideo?.pix_fmt,
        range: fixtureVideo?.color_range,
        primaries: fixtureVideo?.color_primaries,
        transfer: fixtureVideo?.color_transfer,
        space: fixtureVideo?.color_space,
      });

      assert.ok(fixtureVideo, "Generated fixture must contain video.");
      for (const [field, expected] of [
        ["pix_fmt", "yuv420p"],
        ["color_range", "tv"],
        ["color_primaries", "bt709"],
        ["color_transfer", "bt709"],
        ["color_space", "bt709"],
      ]) {
        assert.equal(
          fixtureVideo[field],
          expected,
          "Generated fixture does not satisfy the required source profile: " + field,
        );
      }

      const bytes = new Uint8Array(await readFile(path));
      fixtures.push({ audio, path, bytes, snapshot: bytes.slice() });
    }

    const nativeOptions = args.length === 2 ? { ffmpegPath: ffmpeg, ffprobePath: ffprobe } : {};

    let diagnosticEngine;

    if (process.env.MAVIO_NATIVE_COMPRESSION_DIAGNOSTIC === "1") {
      diagnosticEngine = createNativeEngine(nativeOptions);
      const supports = diagnosticEngine.supports.bind(diagnosticEngine);

      diagnosticEngine.supports = async (plan, source) => {
        const result = await supports(plan, source);

        if (result.status !== "supported") {
          console.dir(
            {
              support: result,
              inputKind: plan.input.kind,
              outputKind: plan.output.kind,
              transformations: plan.transformations,
              terminal: plan.terminal,
              source,
            },
            { depth: null },
          );
        }

        return result;
      };
    }

    const client = createMavio({
      initTimeoutMs: 60_000,
      ...(diagnosticEngine
        ? { engine: diagnosticEngine }
        : args.length === 2
          ? { native: nativeOptions }
          : {}),
    });

    try {
      for (const fixture of fixtures) {
        for (const preset of ["video-balanced-v1", "video-small-v1"]) {
          for (const inputKind of ["path", "bytes"]) {
            for (const outputKind of ["path", "bytes"]) {
              const label = [fixture.audio ? "av" : "video", preset, inputKind, outputKind].join(
                "-",
              );
              const input =
                inputKind === "path"
                  ? { kind: "path", path: fixture.path }
                  : { kind: "bytes", bytes: fixture.bytes };
              const output =
                outputKind === "path"
                  ? { kind: "path", path: join(directory, label + ".mp4") }
                  : { kind: "bytes" };

              const result = await client
                .from(input)
                .compress({ preset })
                .export({ format: "mp4", output });

              assert.equal(result.output.kind, outputKind);
              const video = result.metadata.streams.find((stream) => stream.kind === "video");
              assert.equal(video.width, 320);
              assert.equal(video.height, 180);

              const bytes =
                result.output.kind === "bytes"
                  ? result.output.bytes
                  : new Uint8Array(await readFile(result.output.path));
              assert.ok(
                bytes.length > 0 && bytes.length < fixture.bytes.length,
                "Expected size reduction on the controlled fixture.",
              );
              assert.equal(result.metadata.sizeBytes, bytes.length);

              retained.push({
                fixture,
                preset,
                inputKind,
                outputKind,
                output: result.output,
                snapshot: new Uint8Array(bytes),
              });
              assert.deepEqual(fixture.bytes, fixture.snapshot);
            }
          }
        }
      }
    } finally {
      await client.dispose();
    }

    // All outputs are independently probed and decoded after client disposal.
    for (const [index, item] of retained.entries()) {
      const bytes =
        item.output.kind === "bytes"
          ? item.output.bytes
          : new Uint8Array(await readFile(item.output.path));
      assert.deepEqual(bytes, item.snapshot);

      const path =
        item.output.kind === "path"
          ? item.output.path
          : join(directory, "verify-" + index + ".mp4");
      if (item.output.kind === "bytes") await writeFile(path, bytes);

      const report = JSON.parse(
        run(ffprobe, ["-v", "error", "-show_streams", "-show_frames", "-of", "json", path]),
      );
      const video = report.streams.filter((stream) => stream.codec_type === "video");
      const audio = report.streams.filter((stream) => stream.codec_type === "audio");
      const frames = report.frames.filter((frame) => frame.media_type === "video");

      assert.equal(report.streams.length, item.fixture.audio ? 2 : 1);
      assert.equal(video.length, 1);
      assert.equal(video[0].codec_name, "h264");
      assert.equal(video[0].width, 320);
      assert.equal(video[0].height, 180);
      assert.equal(video[0].sample_aspect_ratio, "1:1");
      assert.equal(frames.length, 6);
      assert.equal(audio.length, item.fixture.audio ? 1 : 0);

      if (item.fixture.audio) {
        assert.equal(audio[0].codec_name, "aac");
        assert.equal(Number(audio[0].sample_rate), 48000);
        assert.equal(audio[0].channels, 1);
      }

      for (const [frameIndex, frame] of frames.entries()) {
        const timestamp = Number(frame.best_effort_timestamp_time);
        assert.ok(Number.isFinite(timestamp) && Math.abs(timestamp - frameIndex / 12) <= 0.0000011);
      }

      run(ffmpeg, [
        "-hide_banner",
        "-v",
        "error",
        "-xerror",
        "-i",
        path,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-f",
        "null",
        "-",
      ]);

      results.push({
        preset: item.preset,
        audio: item.fixture.audio,
        inputKind: item.inputKind,
        outputKind: item.outputKind,
        width: 320,
        height: 180,
        videoFrames: frames.length,
        sourceBytes: item.fixture.bytes.length,
        outputBytes: bytes.length,
      });
    }

    assert.equal(results.length, 16);

    for (const fixture of fixtures) {
      assert.deepEqual(fixture.bytes, fixture.snapshot);
      assert.deepEqual(new Uint8Array(await readFile(fixture.path)), fixture.snapshot);

      for (const inputKind of ["path", "bytes"]) {
        for (const outputKind of ["path", "bytes"]) {
          const rows = results.filter(
            (row) =>
              row.audio === fixture.audio &&
              row.inputKind === inputKind &&
              row.outputKind === outputKind,
          );
          assert.equal(rows.length, 2);

          const balanced = rows.find((row) => row.preset === "video-balanced-v1");
          const small = rows.find((row) => row.preset === "video-small-v1");
          assert.ok(
            small.outputBytes < balanced.outputBytes,
            "Small preset must be smaller on this controlled fixture.",
          );
        }
      }
    }

    console.table(results);
    console.log("All 16 Native public MP4 compression combinations passed.");
    console.log("Post-disposal decoding, geometry, timing and source preservation passed.");
    console.log("Size comparisons apply to this controlled fixture only.");
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("mavio-compression-"));
    await rm(target, { recursive: true, force: true });
  }

  for (const item of retained) {
    if (item.output.kind === "bytes") {
      assert.deepEqual(item.output.bytes, item.snapshot);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error("Native compression acceptance failed.");
  console.error(error);
  process.exitCode = 1;
}
