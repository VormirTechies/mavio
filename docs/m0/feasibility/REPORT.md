# Mavio M0: metadata and trim feasibility

Date: 2026-09-25. Status: **bounded feasibility passed, with a browser metadata workaround**. This is an isolated engine experiment, not an implemented Mavio SDK or completion of all M0 work.

## Environment

| Component | Tested version |
| --- | --- |
| OS / Node | Windows x64 / Node 22.22.2 |
| Native FFmpeg | 6.1.1 essentials build from gyan.dev, via ffmpeg-static 5.3.0 |
| Native FFprobe | 4.0.2 via ffprobe-static 3.1.0 |
| Browser | Headless Chrome 153.0.0.0 |
| Browser API / core | @ffmpeg/ffmpeg 0.12.15 / @ffmpeg/core 0.12.10, single-thread core |
| Embedded browser FFmpeg | 5.1.4 |
| Compiler | TypeScript 7.0.2; @types/node 22.20.4 |

Native FFmpeg and FFprobe versions differ in this experiment. Their success is not evidence that arbitrary version combinations are compatible. The production Node adapter must record both versions and validate its supported pair. Downloads are confined to the test workspace; no binary is added to the repository or globally installed.

## Fixture and method

Generate a six-second synthetic 320x180, 24 fps video with a 440 Hz, 48 kHz mono tone. Encode as MP4 with H.264/AAC. No personal or third-party media is used. Request seconds 1.25 through 3.75, re-encode with libx264 CRF 23, ultrafast, yuv420p and AAC 128 kb/s. These are experiment settings, not an approved final production preset.

The shared command shape is `-i fixture.mp4 -ss 1.25 -t 2.5 -map 0:v:0 -map 0:a:0 -c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart output.mp4`.

## Observed results

| Check | Native | Browser |
| --- | --- | --- |
| Read duration, size, container, bitrate and streams | Pass | Pass with pinned-core shim |
| Normalize source metadata to a common shape | Matches browser | Matches native |
| Preserve unknown numeric fields as absent | Pass in normalization helper | Same helper |
| Trim duration | 2.500000 seconds | 2.500000 seconds |
| Video frame count / start timestamp | 60 / 0.000000 | 60 / 0.000000 |
| First output frame vs source frame 30 | 48.92 dB grayscale PSNR | 48.92 dB |
| Last output frame vs source frame 89 | 46.22 dB grayscale PSNR | 46.22 dB |
| Full output decode | Pass using native decoder | Pass using native decoder; HTML video also loaded |
| Reject invalid media | Nonzero native exit | Shim rejects invalid probe JSON |
| Cancel active execution | Process terminated; observed close latency 32 ms after kill | Worker terminated; pending exec rejected |
| Cleanup and reuse | Test removes partial file; subsequent probe works | Virtual files removed; reload and subsequent probe work |
| Detached output survives disposal | File remains usable | Blob remains decoded after worker termination |

The browser cancellation elapsed time was about 303 ms from exec submission and includes the deliberately scheduled 300 ms delay. It is not a cancellation-latency guarantee. Native cleanup was performed by the harness; production adapter cleanup is still to be implemented. This cancellation check verifies engine stop/restart feasibility, not Mavio's public AbortSignal, queue, race or disposal contract.

The grayscale PSNR threshold for the boundary comparison was 30 dB. Matching boundary frames plus frame count supports this specific constant-frame-rate trim; it does not prove every timestamp/codec combination. Audio decoded successfully but sample-level boundary accuracy and A/V synchronization were not measured independently.

## Browser metadata issue and resolution

The initial strict check failed: valid ffprobe JSON was written but return code was -1. This is recorded in `browser-initial-failure.json` and matches [upstream issue #817](https://github.com/ffmpegwasm/ffmpeg.wasm/issues/817).

For this pinned core only, the experiment deletes any previous probe output, runs with `-show_error -show_format -show_streams -of json`, reads the fresh file, rejects parse errors/error objects/missing format/empty streams, and accepts raw code 0 or the known -1 quirk. The same helper rejects the invalid-media fixture. This is not blanket acceptance of nonzero exits. Production integration must isolate and regression-test the shim, or use a verified fixed build. Truncated files, partially readable streams and stale-output attempts need additional coverage before release.

## Progress and cancellation findings

Browser progress during the 2.5-second trim included approximately 0.42 and then 1.0 at an output time around 2.517 seconds. Raw percentages do not satisfy the public job-level progress contract. The [official API documentation](https://ffmpegwasm.netlify.app/docs/api/ffmpeg/classes/ffmpeg/) limits percentage accuracy to equal input/output durations. Translate known output time against planned duration, reserve completion for successful publication, and omit percent when a trustworthy mapping is unavailable.

Worker termination followed by reloading worked. The adapter must wire cancellation to actual worker termination for this strategy, reject the job, release job resources and reinitialize before subsequent work. Merely rejecting a JavaScript promise is not evidence that encoding stopped.

## Type contract checks

The approved declarations and representative browser/Node consumers compile under strict TypeScript. Positive checks cover Blob and path output inference; negative checks reject time strings, unknown presets and accessing a path on Blob output. Compile with `--lib es2022 --types node` to verify the Node 22 consumer without DOM declarations; compile with `--lib es2022,dom` for the browser-compatible setup. A bare ES-only environment without Node or DOM platform declarations predictably lacks Blob/AbortSignal; this does not imply Node 22 consumers need DOM types. No package exports or distribution types have been tested yet.

## Contract impact

The approved public API does not need a signature change for these results. Add implementation guidance for the pinned browser probe quirk, progress translation and termination/reload behavior. Keep the existing unknown-value, structured-error, cleanup and capability contracts. Production presets and engine-loading options remain unfinished M0 work.

## Scope limits

Not verified: Firefox/Safari/mobile; Node 24/macOS/Linux; other codecs or containers; variable frame rates; rotated media; long or huge files; memory ceilings/leaks; stream selection variants; corrupt-but-partially-decodable files; sample-accurate audio; atomic no-clobber publication; concurrency or abort/publication races. Cross-origin isolation headers were enabled in this test; operation without those headers was not established. This evidence must not be promoted to a universal support matrix.

## Reproduction

This directory is a private standalone experiment. Install exact dependencies with `npm ci`. Run `node native.cjs`, then `node server.cjs`. Open `http://127.0.0.1:4387` in Chrome and press **Run browser validation**. After PASS, run `node verify-outputs.cjs` and `node normalize.cjs`. Copy the current parent `contracts.ts` into this directory before compiling `consumer.ts` using the commands above. The lockfile pins the package dependencies; native executable versions must still be checked in the generated results on each platform.

Evidence JSON and scripts are stored beside this report. Generated media, browsers, profiles and node_modules are excluded from repository delivery. The browser server listens only on loopback and accepts only the explicitly allowlisted experiment result uploads. Stop it after verification.

The test does not implement public input validation. The eventual core must reject negative/reversed/out-of-range trim intervals before starting encoding, as already specified.
