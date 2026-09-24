# Mavio v0.1 preset baseline

Approved by the project owner on 2026-09-25 following the six-preset recommendation. Initial native/browser encoding and decoding checks passed. Definitions below are the v1 baseline; release-quality coverage remains an M5/M6 responsibility.

| ID | Output / encoder | Locked settings | Use |
| --- | --- | --- | --- |
| video-balanced-v1 | MP4 / libx264 + AAC | CRF 23; veryfast; yuv420p; audio 128 kb/s; faststart | General video |
| video-small-v1 | MP4 / libx264 + AAC | CRF 28; veryfast; yuv420p; audio 96 kb/s; faststart | Smaller video with lower quality |
| audio-balanced-v1 | MP3 / libmp3lame | Constant target bitrate 128 kb/s | General audio extraction |
| audio-pcm-v1 | WAV / pcm_s16le | Signed 16-bit little-endian PCM | Uncompressed audio |
| jpeg-balanced-v1 | JPEG / mjpeg | q:v=3; yuvj420p; one frame | Compact thumbnail |
| png-lossless-v1 | PNG / png | rgb24; compression level 6; one frame | Losslessly encoded RGB thumbnail |

## Rules

- Presets do not resize, crop, change frame rate, trim, normalize volume or restore lost quality. Requested transformations remain explicit. Encoder pixel-format conversion is part of each definition.
- Video output uses the selected first video stream and optional first audio stream according to the API policy. No synthetic audio is added when absent. Audio extraction requires the selected audio stream.
- Preserve source audio sample rate and channel layout when the selected encoder supports them; otherwise fail capability validation rather than silently resampling or downmixing. Expanded audio layout support needs its own validation.
- Pixel-format and color compatibility must be checked before execution. These initial encodings are intended for ordinary SDR media; unvalidated HDR/high-bit-depth/alpha conversion must not silently discard meaningful source properties. PNG is lossless relative to the RGB pixels supplied to its encoder, not a promise that decoding/color conversion preserves the original source bytes or alpha.
- JPEG/PNG presets are intended for the terminal thumbnail operation with an explicit time. The feasibility command used the first frame. Still-image export through a generic video export pipeline is not established by this test.
- No preset promises a particular size or that output is smaller than input. PCM is uncompressed and can be substantially larger. Converting lossy audio to PCM does not recover detail.
- A format and preset must match the table. Mismatches are INVALID_OPTIONS. An unavailable required encoder/format is UNSUPPORTED_CAPABILITY. There is no silent codec replacement or fallback.
- WebM remains a future/capability-gated format: there is no built-in v1 preset for WebM. A type union containing webm does not promise it is executable. Its preset and feasibility are deferred.
- Preserve preset semantics across browser and Node. Engine versions may produce different bytes, sizes and timings. Unspecified encoder internals remain tied to the recorded engine build; these presets do not promise byte-identical output.
- Once published, changes to these policy settings require a new preset ID, such as video-balanced-v2. Record any pre-release correction in the architecture decision log.

## Validation evidence

All six presets were run with the same generated six-second 320x180, 24 fps H.264/AAC source used for metadata/trim feasibility. Native: Node 22.22.2 on Windows, FFmpeg 6.1.1. Browser: Chrome 153, @ffmpeg/ffmpeg 0.12.15 with single-thread @ffmpeg/core 0.12.10 (FFmpeg 5.1.4). Every output was independently decoded by native FFmpeg and checked for its expected codec. Video outputs retained 320x180, 24 fps and 144 frames.

| Engine | Preset | Bytes | Encoding wall time | Video PSNR vs decoded source |
| --- | --- | ---: | ---: | ---: |
| Native | balanced | 265,057 | 351 ms | 39.71 dB |
| Native | small | 189,881 | 383 ms | 36.07 dB |
| Browser | balanced | 264,267 | 1,437 ms | 39.78 dB |
| Browser | small | 188,855 | 1,037 ms | 36.12 dB |

Small used 28.36% fewer bytes on native and 28.54% fewer in the browser relative to balanced. This is one illustrative run per preset on one synthetic clip, not a throughput benchmark or subjective quality certification. Native timing includes process startup; browser timing excludes engine loading and filesystem readback. Timing comparisons across engines are therefore not equivalent end-to-end measurements. PSNR describes this synthetic source only.

The MP4 container duration was 6.016 seconds for both presets, while video remained exactly 144 frames / 6 seconds. MP3 reported 6.048 seconds; PCM reported 6.016 seconds. Audio framing/padding needs explicit adapter handling and tests before precise duration preservation can be promised. The earlier 2.5-second trim result does not remove this broader requirement.

## Reproduce

From `feasibility/`, run `npm ci`, then `node native.cjs` to generate the fixture and `node preset-native.cjs` for native preset output. Run `node server.cjs`, visit `http://127.0.0.1:4387/preset.html`, click Run all six presets, and wait for PASS. Run `node preset-verify.cjs` to decode/probe every output and calculate video PSNR. Stop the server when finished.

Exact experimental argument arrays are in `feasibility/presets.json`; these are fixture-oriented commands, not the full production adapter implementation. Measurements are in `preset-native-results.json`, `preset-browser-results.json` and `preset-verification.json` in that directory. No media, native binaries or node_modules are committed as part of this record.
