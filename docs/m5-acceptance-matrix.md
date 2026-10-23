# M5 acceptance matrix

## Baseline and evidence

Audit baseline: cbcd362ad57aaa58250ade2655a846047080c7f8.

Evidence was supplied from local runs on Windows x64, Node v24.22.1.
The working tree includes the M5-09 test-reference correction.
No new commit or updated remote CI result is claimed.

Verified locally:

- Build, type checking, consumer type checks, and lint passed.
- Normal npm test passed after M5-09: 885 SDK tests and 8 helper tests,
  with zero failures, skips, or cancellations.
- Package JSON formatting and git diff --check passed for M5-09.
- Native acceptance passed with FFmpeg and FFprobe
  9.0.2-essentials_build-www.gyan.dev.
- Installed-package Browser acceptance passed all eight checks in
  Chrome/Chromium 156.0.8078.47 using generated corrected assets.
- Browser packages: @ffmpeg/ffmpeg 0.12.15 and @ffmpeg/core 0.12.10.

Passing checks establish their tested scenarios, not arbitrary media support.
Unit tests with injected dependencies do not establish real-engine execution.

## Acceptance matrix

Test filenames below are relative to packages/mavio/tests/runtime/.
Real-media runners are relative to scripts/.

| ID                  | Required behavior                                                                                                                                                    | Existing evidence                                                                                                                                                                                                                         | Remaining verification                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| M5-01 Metadata      | Normalize source metadata; preserve unknown optional values; reject malformed responses; preserve caller inputs and independent results                              | Existing native/Browser parser and client suites; real metadata acceptance; nine explicit cross-parser parity tests passed; see [metadata behavior](m5-metadata.md)                                                                       | Field mapping and missing-value behavior documented; supported media remains engine-dependent                          |
| M5-02 Convert       | Produce decodable MP4, MP3, or WAV with matching approved presets; reject unsupported combinations                                                                   | Shared and engine-specific source guards reviewed; existing conversion/terminal tests and real Native/installed Browser acceptance passed; see [conversion profiles](m5-conversion.md)                                                    | Bounded profiles and runtime differences documented; broader source fixtures remain separate coverage work             |
| M5-03 Trim          | Apply fractional/consecutive trims to the current logical timeline; reject invalid bounds, empty selections, unsupported timing, and malformed evidence              | Shared range/filter/count validation and Browser wrappers reviewed; existing unit and real Native/installed Browser trim acceptance passed; see [trim behavior](m5-trim.md)                                                               | Local acceptance complete for tested timing profiles; broader source fixtures and fresh CI remain separate work        |
| M5-04 Resize        | Fit within a box without upscaling; preserve sequential operations; align MP4 dimensions; validate output geometry                                                   | Native public acceptance and existing unit tests passed; 48 real installed-package public Browser resize combinations passed, including post-disposal decoding                                                                            | Local acceptance complete for tested scenarios; fresh cross-platform CI remains required                               |
| M5-05 Extract audio | Select default/explicit absolute audio stream; preserve supported rates/layouts; reject invalid selection and missing audio; recover without changing source content | Shared selection/profile guards and existing tests reviewed; Native multi-track acceptance passed; focused public Browser selection passed 24 outputs; see [audio extraction](m5-audio-extraction.md)                                     | Real Browser multi-track and negative-case gap addressed; fresh cross-platform CI remains required                     |
| M5-06 Thumbnail     | Produce one JPEG/PNG frame at a trim-relative time; preserve supported preceding trims/resizes; reject unsupported sources and invalid selections                    | Source/filter/resize planning reviewed; existing boundary, selection, profile, and public-routing tests passed; real Native and installed Browser outputs matched independent frame references; see [thumbnail behavior](m5-thumbnail.md) | Local acceptance complete for tested profiles; fresh cross-platform CI remains required                                |
| M5-07 Compress      | Apply an approved preset; preserve explicit transformation semantics; produce valid output without promising universal size reduction                                | Existing contract/audio tests passed; 16 real public MP4 compression combinations passed per runtime with controlled size comparisons and post-disposal decoding; see [compression behavior](m5-compression.md)                           | Controlled compression acceptance established; broader quality/fixture coverage remains M5-08                          |
| M5-08 Presets       | Preserve six approved definitions; reject unsupported profiles/components; verify bounded output quality and correctness                                             | Existing six-preset encoding/output acceptance plus Native/Browser landscape and portrait luma quality gates; shared video rejection cases now exercise both video presets; see [preset coverage](m5-presets.md)                          | Bounded local coverage established; broader media qualification remains future hardening and fresh CI remains required |

## Contracts to preserve

- Metadata describes the untransformed source.
- Generic export supports MP4, MP3, and WAV with approved matching presets.
- JPEG and PNG use the thumbnail terminal.
- WebM has no built-in v1 preset and is deferred.
- Convert and compress must agree on their preset when combined.
- Duplicate convert, compress, and extractAudio declarations are rejected.
- Thumbnail permits preceding trim and resize operations only.
- Resize after audio extraction is rejected.
- Each trim is relative to the preceding logical clip.
- Thumbnail time is relative to the transformed clip and excludes its endpoint.
- MP4 resize fits within a bounding box without upscaling and rounds down
  to even dimensions. Alignment can slightly change the aspect ratio.
- Thumbnail resizing has format-specific alignment; do not apply MP4
  alignment rules to every image output.
- No preset guarantees smaller output, exact output size, or byte identity
  across engine builds.
- Audio sample selection and decoder-dependent codec padding are separate
  concerns. A passing sample-count fixture does not remove that limitation.

## Coverage gaps and follow-up

| ID  | Finding                                                                                                                             | Classification                                              | Next action                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| G01 | Real installed-package public MP4 resize now passes 48 combinations alongside the retained preparation check                        | Closed locally under M5-04                                  | Keep resize-public in the verified suite; obtain fresh cross-platform CI evidence                                                  |
| G02 | Shared field mapping and missing-value behavior now have nine explicit cross-parser parity tests and a field-level reference        | Closed locally under M5-01                                  | Retain parity tests and existing public-client acceptance coverage                                                                 |
| G03 | Composition and terminal restrictions already have tests                                                                            | Mapping/documentation work                                  | Reuse composition.test.mjs, terminals.test.mjs, and preflight.test.mjs                                                             |
| G04 | Six preset definitions, source-profile rejection coverage, controlled compression results, and bounded video quality gates reviewed | Closed locally under M5-08 for the documented fixture scope | Retain the coverage matrix and quality floors; broader media qualification belongs to subsequent hardening                         |
| G05 | Current README guidance corrected; public recipe guide reviewed and locally exercised                                               | Closed locally for the reviewed recipe scope under M5-11    | Retain documented source restrictions and execution limits; installed-tarball execution of the new Browser recipe remains separate |
| G06 | Fresh complete cross-platform CI evidence was not supplied                                                                          | M4 release dependency                                       | Obtain updated CI evidence; local success does not close this gate                                                                 |

No new operation implementation defect was demonstrated by this audit.
The confirmed test-command defect was corrected and verified under M5-09.
Unverified coverage is not automatically a missing feature.

## Execution order

1. M5-04: completed locally; public Browser resize evidence gap closed.
2. M5-01/M5-02: consolidate metadata and supported source-profile coverage.
3. M5-03/M5-05/M5-06: close only demonstrated timing, selection, or parity gaps.
4. M5-07/M5-08: complete bounded preset quality/source-profile coverage.
5. M5-11: completed locally for the reviewed recipe scope; evidence and limitations recorded below.

M5 operation closure requires traceable acceptance evidence and documented
runtime limitations. This matrix does not mark the whole M5 milestone complete.

## M5-04 completion evidence

Local acceptance passed on Windows x64, Node v24.22.1, and
Chrome/Chromium 156.0.8078.47 using generated corrected Browser assets.

The resize-public harness calls the public createMavio pipeline.
The existing internal resize preparation check remains in the suite.
No production SDK implementation was changed for this ticket.

All 48 public combinations passed:

- Two MP4 presets: video-balanced-v1 and video-small-v1.
- Video-only and audio/video sources.
- Single resize, consecutive resize, and combined trim/resize.
- Byte and Blob inputs.
- Byte and Blob outputs.

Outputs are decoded after public-client disposal. Checks cover output kind,
Blob MIME type, engine identity, metadata dimensions, decoded frame counts,
timestamps, square pixels, audio decoding, source preservation, workspace
cleanup, byte ownership, and worker shutdown.

Existing native acceptance verified public resize and combined trim/resize.
Existing unit tests cover invalid dimensions and missing filters.

Verification:

- Focused resize-public Browser check: passed.
- Installed-package verification: all nine Browser checks passed.
- Package imports, Browser bundling, and installed asset CLI: passed.
- ESLint and formatting checks for modified harness files: passed.
- git diff --check before this documentation update: passed.

The complete installed-package suite also passed the corrected stack
regression, MP4 trim, audio, thumbnail, and cancellation checks.

AAC decoding is checked without promising padding-free output.
Evidence applies to the tested scenarios and does not replace fresh
cross-platform CI acceptance.

## M5-11 native recipe execution — 2026-10-23

User-reported local execution on Windows x64, Node v24.22.1, with FFmpeg
and FFprobe 9.0.2-essentials_build-www.gyan.dev:

- The Node conversion example was extracted directly from m5-recipes.md
  and executed with PATH discovery in its child process.
- Source metadata and MP4 path output succeeded without cleanup warnings.
- The documented MP3, WAV, compression, JPEG, and PNG snippets executed.
- Fractional trim followed by resize and MP4 export succeeded.
  The 320x240 fixture remained 320x240 inside a 640x360 bounding box,
  confirming no upscaling for this case.
- All seven outputs were independently probed and decoded after disposal.

Fixture: three-second 320x240, 24 fps H.264/yuv420p MP4, square pixels,
explicit bt709 primaries/transfer/color space, tv range, and 48000 Hz mono AAC.

An initial fixture missing required color metadata was rejected with
UNSUPPORTED_CAPABILITY. A corrected fixture passed; no SDK change was made.

Browser recipe execution, progress/cancellation examples, final documentation
checks, and fresh cross-platform CI evidence remain outstanding.
These native results do not establish those checks.

## M5-11 Browser recipe execution — 2026-10-23

User-reported local execution on Windows x64, Node v24.22.1,
Chromium 153.0.8010.12, using the workspace SDK and generated corrected assets:

- The exact documented makeClip function was extracted and bundled.
- Blob input and output succeeded.
- The output survived disposal and independently passed native probing and decoding.
- Fractional trim produced approximately one second of video.
- Resize retained the fixture's 320x240 dimensions without upscaling.
- Five progress messages were observed.
- An already-aborted signal rejected with CANCELLED.
- The existing cancellation harness separately interrupted active encoding
  after real progress without publication.
- Same-client recovery reloaded the worker and produced 6000 exact PCM samples.
- Lifecycle, initialization failure/retry, timeout, disposal, and source
  metadata checks in that focused harness also passed.

Observed active cancellation latency was 2 ms in this run; this is not a
performance guarantee.

This run did not use an installed tarball and did not rerun the full
12-check Browser suite. Earlier installed-package evidence remains separate.
Fresh cross-platform CI remains an outstanding release requirement.
Final documentation link, JavaScript syntax, script-token, formatting, and diff checks passed. See the local closure record below.

## M5-11 local closure — 2026-10-23

Completed locally for the reviewed README guidance and public recipe guide:

- Corrected both READMEs and the obsolete public-contract header comment.
- Documented runtime configuration, generated Browser assets, source-profile
  requirements, supported operations, disposal, and limitations.
- Executed the documented Node conversion and additional native snippets.
- Independently probed and decoded seven native outputs after disposal.
- Executed the exact documented Browser makeClip function against the workspace SDK.
- Verified its output, trim/resize behavior, progress delivery, and pre-aborted signal.
- Separately passed active Browser cancellation, no-publication, and recovery checks.
- Consumer type checks passed.
- All 22 checked local documentation links exist.
- All eight checked JavaScript snippets passed syntax checks.
- Script audit found 109 registered test files and no missing or joined paths.
- Formatting and git diff whitespace checks passed before this closure edit.

Earlier checkpoint notes describe status at the time recorded.
This closure does not claim that every historical documentation example was executed.

Installed-tarball execution of the new Browser recipe was not performed.
Earlier installed-package acceptance evidence remains separate.
Fresh cross-platform CI and other outstanding M4 release gates remain open.
Local M5-11 closure does not mark the overall M5 milestone or release complete.
