# M5 compression behavior

## Contract

compress({ preset }) selects encoding settings.
It does not accept an exact target size or guarantee that output is smaller.

The preset does not implicitly resize, crop, trim, change frame rate,
normalize volume, or restore lost detail. Transformations remain explicit.

Choose the matching export format:

    const result = await client.from(input)
      .compress({ preset: "video-small-v1" })
      .export({ format: "mp4", output: { kind: "bytes" } });

The export format is required unless a compatible convert declaration
already supplies it. If convert and compress are combined, their presets
must agree. Duplicate compression declarations are rejected.

## Preset behavior

| Preset            | Output | Settings relevant to size                                    |
| ----------------- | ------ | ------------------------------------------------------------ |
| video-balanced-v1 | MP4    | H.264 CRF 23, veryfast, yuv420p; selected AAC audio 128 kb/s |
| video-small-v1    | MP4    | H.264 CRF 28, veryfast, yuv420p; selected AAC audio 96 kb/s  |
| audio-balanced-v1 | MP3    | libmp3lame; target bitrate 128 kb/s                          |
| audio-pcm-v1      | WAV    | Uncompressed signed 16-bit PCM                               |

Both video presets use faststart.
Higher video CRF generally trades quality for fewer bytes; this is not a
universal file-size ordering guarantee.

PCM is uncompressed and may be substantially larger than its input.
Calling compress with audio-pcm-v1 does not turn PCM into a size-reducing codec.

JPEG/PNG presets belong to the thumbnail terminal.
WebM output has no built-in v1 preset.

## Size and quality limits

Output size depends on input encoding, content, duration, container overhead,
selected streams, and engine build. Already compressed or very small inputs
can produce larger outputs.

A larger output is not automatically an execution failure.
Successful output must still satisfy its format, stream, and validation rules.

Size reduction alone does not establish acceptable visual or audio quality.
Controlled fixture comparisons are acceptance evidence, not a general
benchmark or subjective quality certification.

Presets do not promise byte-identical results across Native and Browser.
See m5-conversion.md for supported source profiles and runtime differences.

## Controlled MP4 acceptance

The new checks call the public compress API without trim or resize.

Each runtime covers 16 combinations:

- video-balanced-v1 and video-small-v1.
- Video-only and audio/video sources.
- Every supported input/output-kind combination:
  Native path/bytes, Browser bytes/Blob.

The synthetic source is 320x180, 12 fps, and six video frames.
The audio/video variant includes 48000 Hz mono audio.
The Native generator explicitly tags frame color metadata as BT.709
limited-range SDR and verifies that profile before calling Mavio.

Within each runtime, both presets use the same source bytes for a given
audio case. The checks require both outputs to be smaller than that fixture,
and small output to be smaller than balanced output.

These assertions are fixture-specific. They do not add a public guarantee
that arbitrary input must shrink.

## Observed local sizes

| Runtime | Source      | Input bytes | Balanced bytes | Small bytes |
| ------- | ----------- | ----------: | -------------: | ----------: |
| Native  | Video-only  |       34212 |          12635 |        9211 |
| Native  | Audio/video |       39630 |          21569 |       16419 |
| Browser | Video-only  |       34199 |          12628 |        9172 |
| Browser | Audio/video |       39638 |          21668 |       16434 |

Native and Browser use different FFmpeg builds and independently generated
fixtures. These figures do not establish equivalent quality or throughput
between runtimes.

## Correctness and lifecycle

Acceptance verifies planned dimensions, six decoded video frames, preserved
video timestamps, square pixels, audio presence/absence, valid decoding,
caller source preservation, and output validity after client disposal.

Browser verification also checks all byte/Blob combinations and worker cleanup.
Native verification checks path/byte outputs after disposal and returned byte
ownership after temporary-file cleanup.

Existing public MP3/WAV checks exercise compress as well as convert.
Existing contract tests cover preset conflicts and invalid terminal formats.

## Evidence and commands

Focused Browser check passed with MAVIO_BROWSER_CHANNEL=chrome and
MAVIO_BROWSER_SMOKE=compression-public:

    npm run check:browser:client

Focused Native check passed:

    node scripts/check-native-compression.mjs "D:\Softwares\ffmpeg\bin\ffmpeg.exe" "D:\Softwares\ffmpeg\bin\ffprobe.exe"

The Native check is registered in check-native-all.mjs.
Browser compression is registered in check-browser-verified.mjs,
bringing that suite to eleven checks.

Local environment: Windows x64, Node v24.22.1,
Native FFmpeg/FFprobe 9.0.2-essentials_build-www.gyan.dev,
and Chrome/Chromium 156.0.8078.47.
Browser uses pinned packages with generated corrected core assets.

No production SDK implementation changed under M5-07.
Broader representative quality/fixture coverage remains M5-08 work.
Fresh cross-platform CI remains required for release acceptance.
