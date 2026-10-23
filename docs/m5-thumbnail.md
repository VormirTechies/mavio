# M5 thumbnail behavior

## Public terminal

thumbnail({ at, format, preset, output }) executes a thumbnail request.

| Format | Preset           | Encoding                                   |
| ------ | ---------------- | ------------------------------------------ |
| jpeg   | jpeg-balanced-v1 | mjpeg, q:v=3, yuvj420p, one frame          |
| png    | png-lossless-v1  | png, rgb24, compression level 6, one frame |

Format and preset must match. Generic export is not the image terminal.
Only preceding trim and resize transformations are accepted.

Native supports path/byte inputs and outputs.
Browser supports byte/Blob inputs and outputs.

Example, assuming a configured client and supported source:

    const result = await client.from(input)
      .trim({ start: 1, end: 4 })
      .resize({ width: 320, height: 180 })
      .thumbnail({
        at: 0.5,
        format: "jpeg",
        preset: "jpeg-balanced-v1",
        output: { kind: "bytes" },
      });

Here at refers to source time 1.5 seconds within the retained interval.
Dispose the client after its work completes.

## Frame selection

Select the first video stream in source metadata order.
The operation does not expose an explicit video-stream selection option.
Audio is omitted and its profile does not determine thumbnail compatibility.

The selected frame is the first decoded frame at or after the requested source
time, strictly before the retained clip's end. Selection is not nearest-frame
rounding and does not guarantee a frame exactly at the requested timestamp.

at must be finite, nonnegative, and strictly less than the transformed duration.
A known valid source duration is required.
Consecutive trims use the preceding logical timeline; resize leaves timing unchanged.

A valid numeric time can still leave no eligible video frame.
Actual frame availability is checked before image encoding.
Empty selection rejects and must not publish a successful image.

## Timing limits

The current selection path requires detected source origin zero.
Unknown and nonzero origins reject.

Resolved selection start and end must round-trip exactly through safe-integer
microseconds. Unsupported precision rejects rather than being silently rounded.
This applies after trim-relative offsets have been added.

Thumbnail selection resets its selected video timestamps with PTS-STARTPTS.
This is a terminal image operation; it does not define MP4 audio/video rebasing.

## Source profile

The selected video requires:

- Matching detailed stream metadata.
- Explicitly non-attached video, rather than cover art.
- yuv420p pixel format.
- bt709 transfer, primaries, and color space with tv color range.
- Verified default orientation and absent/zero rotation.
- Explicit 1:1 sample aspect ratio.
- Positive safe-integer stored width and height.

Audio-only sources reject because they lack a video stream.
Unknown or unsupported color, pixel, orientation, or geometry information
does not silently become an assumed compatible profile.
Browser additionally checks the selected source decoder.

The current profile does not promise arbitrary HDR, alpha, high-bit-depth,
rotated, or nonsquare-pixel source conversion.

## Resize behavior

Each resize specifies a bounding box, rather than exact forced dimensions.
The implementation fits within the box without upscaling.
Consecutive resizes use the preceding result's dimensions.

For requested resize steps:

- JPEG rounds each fitted dimension down to a multiple of two.
- PNG uses integer dimensions and permits odd dimensions.
- Rounding can slightly change the aspect ratio.
- A result collapsing to zero dimensions rejects.
- Scaling requires scale and setsar filters and produces square pixels.

Without resize, this helper retains the source dimensions.
JPEG resize alignment must not be described as a universal rule for every
unresized source or PNG result.

## Quality and output validation

JPEG is lossy.
PNG is lossless relative to the RGB pixels supplied to its encoder.
PNG does not promise original source-byte identity, preserved alpha, or
reversal of decoding/color-conversion losses.

The preset does not automatically resize or choose a representative scene.
The caller selects the time and any resize transformations.

Existing output validation checks the image codec, one video stream,
planned dimensions, supported pixel profile, and valid nonempty output.
Browser byte validation additionally checks image structure/signatures.

## Failures

| Condition                                                      | Handling                                             |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| Missing video or invalid required source dimensions            | INVALID_MEDIA                                        |
| Unsupported source profile or missing required engine features | UNSUPPORTED_CAPABILITY                               |
| Invalid time, endpoint, format/preset, or composition          | INVALID_OPTIONS                                      |
| Unknown required duration                                      | INVALID_MEDIA                                        |
| Unsupported origin or microsecond precision                    | UNSUPPORTED_CAPABILITY                               |
| Resize collapses after fitting/alignment                       | INVALID_OPTIONS                                      |
| No eligible frame                                              | Structured empty-selection rejection before encoding |
| Malformed analysis or invalid generated output                 | Structured execution/finalization failure            |

The first failing validation determines the reported error.
A valid timestamp alone does not establish that a usable frame exists.

## Acceptance evidence

Existing tests cover source order, audio-only/missing video, attached pictures,
source profiles, orientation, pixel geometry, timestamps, duration boundaries,
precision loss, consecutive trims, resize alignment, missing filters,
composition, public routing, publication gates, and recovery.

Real Native acceptance passed JPEG/PNG encoding and single-frame decoding,
public path/byte combinations, overwrite protection, source preservation,
sequential resize, and comparison with independently selected source frame 13.

Installed-package Browser acceptance passed eight public format/input/output
combinations and two empty-selection recovery outputs. All ten images decoded
and matched independent references after disposal.

The full ten-check installed-package Browser suite passed during M5-05,
including the unchanged thumbnail acceptance route.
The registered SDK baseline passed 894 tests and eight helper tests.

No production thumbnail change was required for M5-06.
Evidence covers the tested media profiles; fresh cross-platform CI remains required.
