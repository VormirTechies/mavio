# M3 native validation

Status: complete.
Evidence recorded: 2026-10-19.

## Completion summary

The project owner confirmed that implementation checks, regression tests,
package verification, and all 10 CI jobs passed.

M3 delivers the native FFmpeg engine for the supported source profiles,
operations, presets, and input/output routes described below.

These results establish compatibility with the tested configurations and
fixtures. They do not establish support for every FFmpeg build, operating
system version, architecture, codec, or input profile.

## Verified native CI configurations

| CI platform  | Architecture | Verified Node versions |
| ------------ | ------------ | ---------------------- |
| macos-15     | arm64        | 22.23.2, 24.20.0       |
| windows-2025 | x64          | 22.23.3, 24.21.0       |
| Ubuntu 24.04 | x64          | 22.23.3, 24.21.0       |

Reported FFmpeg and FFprobe versions:

| Platform | FFmpeg                              | FFprobe                             |
| -------- | ----------------------------------- | ----------------------------------- |
| macOS    | 9.0.1                               | 9.0.1                               |
| Windows  | 9.0.2-essentials_build-www.gyan.dev | 9.0.2-essentials_build-www.gyan.dev |
| Ubuntu   | 6.1.1-3ubuntu5                      | 6.1.1-3ubuntu5                      |

The tool versions above were supplied from the Node 22 native jobs.
All six native jobs passed; their logs record the exact tool versions
installed for each run.

Additional local native acceptance checks passed on Windows.

## CI coverage

| Verification group                                                 | Jobs |
| ------------------------------------------------------------------ | ---- |
| Package/browser verification on Ubuntu and Windows, Node 22 and 24 | 4    |
| Native Ubuntu acceptance, Node 22 and 24                           | 2    |
| Native Windows acceptance, Node 22 and 24                          | 2    |
| Native macOS acceptance, Node 22 and 24                            | 2    |
| Total                                                              | 10   |

Package/browser verification covers the existing package exports,
type checks, browser bundling, and Chromium runtime checks.
It does not establish completion of the M4 browser media engine.

## Verified native functionality

### Initialization and metadata

- Discover FFmpeg and FFprobe or use explicit executable paths.
- Inspect available encoders, decoders, muxers, demuxers, and filters.
- Advertise supported routes based on installed features.
- Probe supported path and byte inputs through the public API.
- Return normalized metadata.
- Reject invalid media and recover for subsequent operations.

### Video processing

Verified presets:

| Preset            | Container | Video | Audio when present |
| ----------------- | --------- | ----- | ------------------ |
| video-balanced-v1 | MP4       | H.264 | AAC                |
| video-small-v1    | MP4       | H.264 | AAC                |

Verified behavior:

- Path and byte inputs.
- Path and byte outputs.
- Accurate source selection for the exercised trim fixtures.
- Consecutive trim operations.
- Fractional video timestamps.
- Empty required-stream selection rejection.
- Sequential resize within requested bounds.
- No upscaling of a preceding resize result.
- Combined trim and resize.
- Output codec, dimensions, geometry, and decoding validation.

### Audio processing

Verified presets:

| Preset            | Container | Codec                           |
| ----------------- | --------- | ------------------------------- |
| audio-balanced-v1 | MP3       | MP3                             |
| audio-pcm-v1      | WAV       | Signed 16-bit little-endian PCM |

Verified behavior:

- Path and byte inputs and outputs.
- Default and explicit audio-stream selection.
- Rejection of missing, absent-index, and non-audio stream selections.
- Supported mono/stereo profiles and sample-rate preservation.
- WAV re-input through the public API.
- Trim analysis and empty-audio rejection.
- Public trimmed byte and path outputs.
- Recovery after rejected operations.
- Exact source-sample comparison for the exercised PCM WAV trim fixture.

### Thumbnails

Verified presets:

| Preset           | Format | Pixel format |
| ---------------- | ------ | ------------ |
| jpeg-balanced-v1 | JPEG   | yuvj420p     |
| png-lossless-v1  | PNG    | rgb24        |

Verified behavior:

- Path and byte inputs and outputs.
- Image signatures and complete single-frame decoding.
- Empty-frame selection rejection.
- Thumbnail requests relative to the transformed timeline.
- Consecutive trim and resize.
- JPEG dimension alignment and odd-sized RGB PNG output.
- No upscaling of a preceding resize result.
- Comparison against an independently selected source frame.
- Output validation after workspace cleanup and client disposal.

For the exercised 24 fps fixture, a request at source time 0.51 seconds
selected frame 13, the first frame at or after the requested time.

The decoded thumbnail matched a reference generated from that independently
selected frame using the same encoding preset. This does not claim that
JPEG is lossless relative to the original source.

## Input/output ownership and publication

Verified acceptance checks cover:

- Intermediate-output overwrite protection.
- Public destination overwrite rejection.
- Preservation of existing destination contents.
- Recovery on the same client after rejected operations.
- Fresh staging workspaces for separate operations.
- Source file and source byte preservation.
- Returned bytes remaining usable after staging cleanup.
- Published paths remaining usable after client disposal.
- Cleanup of temporary files.

Regression tests also cover cancellation boundaries, failure precedence,
malformed analysis responses, output validation failures, and independent
returned byte storage.

These tests do not imply exhaustive coverage of every filesystem,
disk-full condition, permission configuration, or process-termination
scenario.

## AAC timing and padding policy

Source-sample selection, encoded presentation duration, and the number of
samples returned by a consuming decoder are separate concerns.

The fractional MP4 fixture requests 47,040 audio samples at 48 kHz.

The tested Ubuntu toolchain exposed 47,104 decoded samples in the combined
trim-and-resize check. The acceptance check requires:

- A declared audio start timestamp of zero.
- A declared audio duration of exactly 47,040 samples.
- Continuous decoded timestamps.
- No shortage of decoded samples.
- Any excess samples to be confined to the final overlapping AAC frame.
- The fixture-specific AAC frame-size and frame-boundary checks to pass.

The separate source-selection checks remain exact.
The verification decoder does not trim away excess samples to make the
assertion pass.

Both native MP4 presets expose the following public encoding capability:

    audioPadding: "decoder-dependent"

This declaration means:

- A supported export does not guarantee universally sample-exact AAC decoding.
- Consuming decoders may expose trailing codec padding.
- The limitation applies conservatively across native tool versions.
- The declaration does not relax source-selection rules.
- An omitted audioPadding field means unspecified behavior, not padding-free
  or sample-exact behavior.
- No sample-exact AAC export mode is currently exposed.

For video-only output, the capability describes the preset's behavior when
audio is present; it does not imply that audio will be added.

## Compatibility boundaries

The implementation validates installed features and source profiles before
using a processing route. Unsupported combinations must fail explicitly;
presets do not silently switch codecs.

The exercised fixtures do not establish general support for:

- HDR, alpha, or high-bit-depth preservation.
- Arbitrary rotation or anamorphic-source normalization.
- Every channel layout or sample rate.
- Every variable-frame-rate or nonzero-origin timeline.
- Every container or decoder present in an FFmpeg build.
- Every macOS or Windows architecture.

The approved scope, presets, and edge-case contract remain authoritative:

- [Scope](m0/scope.md)
- [Presets](m0/presets.md)
- [Edge cases](m0/edge-cases.md)

## Verification commands

Run from the repository root.

General verification:

    npm run check

Combined native acceptance with tools available on PATH:

    npm run check:native:all

Combined native acceptance with explicit Windows paths:

    npm run check:native:all -- "D:\Softwares\ffmpeg\bin\ffmpeg.exe" "D:\Softwares\ffmpeg\bin\ffprobe.exe"

Individual native checks:

    npm run check:native
    npm run check:native:media
    npm run check:native:audio
    npm run check:native:thumbnail

Each individual command also accepts explicit FFmpeg and FFprobe paths.

The combined native command builds once and runs tool discovery, video,
audio, and thumbnail checks sequentially. It stops on the first failure.

Expected final output:

    All native acceptance checks passed.

## M3 closeout checklist

- [x] Native implementation completed for the documented scope.
- [x] General verification and regression tests passed.
- [x] Local Windows native acceptance passed.
- [x] Ubuntu native CI passed on Node 22 and 24.
- [x] Windows native CI passed on Node 22 and 24.
- [x] macOS native CI passed on Node 22 and 24.
- [x] All 10 CI jobs passed.
- [x] Tested Node versions and architectures recorded.
- [x] Reported FFmpeg and FFprobe versions recorded.
- [x] AAC padding limitation exposed through public capabilities.
- [x] Compatibility boundaries documented.

M3 is complete. M4 browser media-engine integration is a separate milestone
and is not marked complete by this document.
