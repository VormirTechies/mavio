# M5 preset coverage

## Approved definitions

The settings in docs/m0/presets.md remain the approved v1 baseline.
M5 did not change production preset settings.

| Preset            | Output | Locked settings                                                           |
| ----------------- | ------ | ------------------------------------------------------------------------- |
| video-balanced-v1 | MP4    | libx264 CRF 23; veryfast; yuv420p; selected AAC audio 128 kb/s; faststart |
| video-small-v1    | MP4    | libx264 CRF 28; veryfast; yuv420p; selected AAC audio 96 kb/s; faststart  |
| audio-balanced-v1 | MP3    | libmp3lame; target bitrate 128 kb/s                                       |
| audio-pcm-v1      | WAV    | pcm_s16le                                                                 |
| jpeg-balanced-v1  | JPEG   | mjpeg; q:v=3; yuvj420p; one frame                                         |
| png-lossless-v1   | PNG    | png; rgb24; compression level 6; one frame                                |

Required encoders and muxers are checked without silent replacement.
Unknown presets and mismatched formats reject.
WebM output has no built-in v1 preset.

Presets do not implicitly trim, resize, crop, change frame rate, normalize
volume, or restore lost detail. Published policy changes require a new preset
ID; any pre-release correction must be recorded in the decision log.

## Coverage by preset

| Preset            | Existing correctness evidence                                             | Additional M5 evidence                                                                       |
| ----------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| video-balanced-v1 | Native/Browser encoding, decoding, stream and timing validation           | Public compression matrix, controlled size comparisons, landscape/portrait luma quality gate |
| video-small-v1    | Native/Browser encoding, decoding, stream and timing validation           | Public compression matrix, controlled size comparisons, landscape/portrait luma quality gate |
| audio-balanced-v1 | MP3 encoding/decoding, rate/layout preservation, selection and recovery   | Public multi-track selection across byte/Blob combinations                                   |
| audio-pcm-v1      | PCM encoding/decoding and exact sample-reference checks                   | Exact selected-track PCM comparisons after public-client disposal                            |
| jpeg-balanced-v1  | Signature/codec/dimensions, single-frame decoding, reference-frame checks | Thumbnail source, boundary, alignment, and lifecycle contract consolidated                   |
| png-lossless-v1   | RGB output validation, structure/dimensions, reference-frame checks       | Thumbnail source, boundary, odd-dimension resize, and lifecycle contract consolidated        |

PCM reference equality is not a lossless-quality claim for MP3.
PNG is lossless relative to encoder-input RGB pixels, not original media bytes.
JPEG and MP3 are covered by encoding policy, decoding, selection, and lifecycle
checks; this work does not certify their subjective quality.

## Video quality fixtures

Two one-second, video-only testsrc2 fixtures run at 12 fps:

- landscape-motion: 320x180, 12 frames.
- portrait-motion: 180x320, 12 frames.

The source uses H.264 CRF 18 and ultrafast encoding.
Source and output are decoded to yuv420p before comparison.
Quality is measured against decoded source pixels, so it describes additional
encoding error rather than error against the original generator.

For each frame, only the Y plane contributes to mean squared error.
Luma PSNR is computed as 10 * log10(255 squared / MSE).
Zero MSE is treated as identical pixels.

## Regression floors

| Preset            | Minimum fixture luma PSNR |
| ----------------- | ------------------------: |
| video-balanced-v1 |                     38 dB |
| video-small-v1    |                     34 dB |

These conservative floors apply only to the named fixtures.
They are not universal image-quality guarantees or subjective acceptance scores.
They do not measure chroma error, audio quality, perceptual artifacts, or every
possible temporal defect.

Native gates compare unrounded measurements. Browser measurement code also
checks its unrounded value before returning rounded report values.

## Observed local measurements

| Runtime | Fixture          | Balanced PSNR | Small PSNR |
| ------- | ---------------- | ------------: | ---------: |
| Native  | landscape-motion |    43.2374 dB | 38.8918 dB |
| Native  | portrait-motion  |    42.7125 dB | 38.1451 dB |
| Browser | landscape-motion |    43.2797 dB | 38.8700 dB |
| Browser | portrait-motion  |    42.6888 dB | 38.1730 dB |

Native ran four quality cases. Browser ran sixteen cases across both presets,
both geometries, and every byte/Blob input/output combination.
Output verification occurs after public-client disposal.

Native and Browser generate fixtures using their respective engine builds.
These observations do not establish byte equality or an equivalent perceptual
quality benchmark across runtimes.

## Rejection coverage

Shared MP4 profile rejection cases now run against both video preset IDs,
assert the selected preset in error context, and check input immutability.

Existing assertions include:

- High-bit-depth, alpha, unknown, or missing supported pixel profiles.
- HDR transfer functions and unsupported/unknown color properties.
- Full-range input outside the limited-range baseline.
- Missing/attached-picture disposition.
- Unsupported sample rates and inconsistent/multichannel layouts.
- Browser selected-decoder availability.
- Unsupported orientation, pixel geometry, and dimensions.
- Audio preset rate/layout constraints and narrowly scoped PCM WAV inference.
- Thumbnail SDR, orientation, geometry, and source-video requirements.
- Exact required encoders/muxers and format/preset agreement.

See m5-conversion.md, m5-audio-extraction.md, and m5-thumbnail.md for public
scope and runtime differences. These are targeted unit and acceptance cases,
not an exhaustive real-media corpus covering every rejected profile.

## Commands

Native quality gates:

    node scripts/check-native-preset-quality.mjs "D:\Softwares\ffmpeg\bin\ffmpeg.exe" "D:\Softwares\ffmpeg\bin\ffprobe.exe"

The quality runner is registered in check-native-all.mjs.

Focused Browser quality gates use MAVIO_BROWSER_CHANNEL=chrome and
MAVIO_BROWSER_SMOKE=preset-quality-public:

    npm run check:browser:client

Browser quality is registered in check-browser-verified.mjs, bringing that
suite to twelve checks.

## Environment and limits

Local evidence: Windows x64, Node v24.22.1,
Native FFmpeg/FFprobe 9.0.2-essentials_build-www.gyan.dev,
Chrome/Chromium 156.0.8078.47, and pinned Browser packages with generated
corrected core assets.

Longer clips, natural-camera footage, speech/music perceptual assessment,
additional source codecs/containers, HDR, alpha, multichannel audio, and broader
device/memory behavior require subsequent qualification.

Fresh cross-platform CI remains required for release acceptance.
