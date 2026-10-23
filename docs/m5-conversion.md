# M5 conversion profiles

## Output formats

| Output | Required preset   | Encoded streams                                             |
| ------ | ----------------- | ----------------------------------------------------------- |
| MP4    | video-balanced-v1 | H.264 using libx264; optional selected audio encoded as AAC |
| MP4    | video-small-v1    | H.264 using libx264; optional selected audio encoded as AAC |
| MP3    | audio-balanced-v1 | One selected audio stream using libmp3lame                  |
| WAV    | audio-pcm-v1      | One selected audio stream using pcm_s16le                   |

The requested format must match its preset.
Generic export supports MP4, MP3, and WAV.
JPEG/PNG use the thumbnail terminal.
WebM output has no built-in v1 preset and remains deferred.

Output encoders and muxers must be available. There is no silent encoder
substitution. Browser processing requires generated corrected core assets.

## Input and output kinds

| Runtime | Input                                   | Output                   |
| ------- | --------------------------------------- | ------------------------ |
| Native  | Filesystem path or bytes                | Filesystem path or bytes |
| Browser | Bytes or Blob, including File as a Blob | Bytes or Blob            |

Browser filesystem paths and Native Blob inputs/outputs are outside these
runtime routes. Node Buffer can be supplied as a byte input.

## Source support

A filename extension or readable-container inventory entry does not establish
conversion support. The engine must read and decode the selected streams,
the source must meet the validated profile, and the requested plan must pass
capability checks.

Source container names are not a fixed allowlist in the reviewed source
validators. This does not establish acceptance for every readable container.
WebM output being deferred does not itself define WebM input support.

### MP4 video profile

- Select the first video stream in metadata order.
- Select the first audio stream in metadata order when present.
- Preserve absolute selected stream indexes; do not select by lowest index.
- Omit additional streams according to the preset policy.
- Require detailed metadata identifying the selected video as not attached art.
- Require yuv420p video with bt709 transfer, primaries, and color space,
  and tv color range.
- Require selected audio, when present, to use 44100 or 48000 Hz.
- Require explicit consistent mono/one-channel or stereo/two-channel audio.
- Produce positive, safe-integer, even MP4 output dimensions.
- Do not synthesize audio when the source has none.
- Do not silently drop selected audio because its profile is unsupported.

HDR, high-bit-depth, alpha, unknown pixel/color profiles, and unsupported audio
profiles are rejected rather than silently converted under these presets.

### MP3 and WAV audio profile

- Require an audio stream.
- Default to the first audio stream in metadata order.
- An explicit extraction streamIndex identifies an absolute source stream index.
- Require 44100 or 48000 Hz, preserving the selected supported rate.
- Require mono/one-channel or stereo/two-channel layout.
- Permit implicit mono/stereo layout only when the source container is exactly
  wav, the selected codec is pcm_s16le, and layout metadata is absent.
- Do not override contradictory explicit layouts or infer multichannel layouts.
- Reject absent/non-audio explicit indexes without falling back.
- Produce one audio stream; video is not included in audio output.

Converting lossy audio to PCM does not recover detail.
Decoded sample counts can depend on codec padding and decoder behavior.

## Runtime differences

| Concern                  | Browser                                                                                            | Native                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Selected source decoders | Explicit source guards require advertised decoder names for selected streams                       | Reviewed source guards do not perform the same explicit inventory check; successful probing alone does not prove decoding |
| MP4 source geometry      | Requires positive even dimensions and explicit 1:1 sample aspect ratio before command construction | Command checks resulting even dimensions; resize additionally validates source geometry                                   |
| Orientation              | Requires verified default orientation and absent/zero rotation                                     | Public support check rejects known nonzero rotation; do not infer identical handling of unknown orientation               |
| Filesystem publication   | Byte/Blob publication through the client                                                           | Path publication includes overwrite protection                                                                            |

These differences do not broaden the validated common profile. Square-pixel,
unrotated, ordinary SDR fixtures form the current shared real-media baseline.
Unknown or unsupported source properties must not be advertised as tested
cross-runtime conversion support.

## Pipeline declarations

convert selects a matching format and preset. export selects the output target.
An explicit export format must agree with convert.

If convert and compress are combined, both must use the same preset.
Duplicate convert or compress declarations are rejected.
A video preset conflicts with audio extraction.

Presets do not implicitly resize, crop, trim, change frame rate, normalize
volume, or restore lost quality. Such operations require explicit supported
pipeline transformations.

## Examples

These expressions assume an initialized client and a runtime-compatible input.

MP4:

    const result = await client.from(input)
      .convert({ format: "mp4", preset: "video-balanced-v1" })
      .export({ output: { kind: "bytes" } });

MP3:

    const result = await client.from(input)
      .convert({ format: "mp3", preset: "audio-balanced-v1" })
      .export({ output: { kind: "bytes" } });

WAV:

    const result = await client.from(input)
      .convert({ format: "wav", preset: "audio-pcm-v1" })
      .export({ output: { kind: "bytes" } });

Dispose the client after its work completes. Browser clients need explicit
application-hosted asset URLs. Native clients need available FFmpeg/FFprobe
binaries or explicit binary paths.

## Error behavior

| Condition                                         | Expected handling                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Unknown preset or mismatched format/preset        | INVALID_OPTIONS                                                                       |
| Conflicting encoding declarations                 | INVALID_OPTIONS                                                                       |
| Unsupported validated source profile              | UNSUPPORTED_CAPABILITY                                                                |
| Missing required output encoder/muxer             | UNSUPPORTED_CAPABILITY                                                                |
| Missing selected source decoder in Browser guards | UNSUPPORTED_CAPABILITY                                                                |
| Missing required video/audio                      | Structured rejection; source-selection helpers use INVALID_MEDIA                      |
| Invalid explicit audio stream selection           | INVALID_OPTIONS                                                                       |
| Occupied Native output path                       | OUTPUT_EXISTS                                                                         |
| Engine decoding/processing failure                | Structured execution failure; do not promise successful decoding from inventory alone |

The first failing validation determines the reported error.
Internal reason identifiers and exact rejection points can differ by runtime.

## Evidence and limits

Existing passing tests cover source profiles, stream selection, command
construction, format/preset conflicts, exact required components, and
unsupported combinations.

Relevant suites include native-mp4-source, native-mp4-command,
native-audio-source, browser-mp4-command, browser-audio-command,
transformations, composition, terminals, and preflight.

Real Native and installed-package Browser checks already passed MP4 video
conversion, MP3/WAV audio output, decoding, cleanup, and recovery.
Native acceptance also exercised WAV re-input.

The registered baseline passed 894 SDK tests and eight helper tests.
No production conversion code changed under M5-02.
This document records reviewed contracts and existing evidence, rather than
claiming a new exhaustive input-container or source-codec acceptance matrix.
Broader representative fixtures remain M5-07/M5-08 coverage work.

Fresh cross-platform CI remains required for release acceptance.
