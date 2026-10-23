# M5 trim behavior

## Public operation

trim({ start, end }) adds a time-range transformation in seconds.
Values must be finite, start must be nonnegative, and end must exceed start.
Trimming requires a known valid duration and rejects an end beyond the current
logical clip. Excessive ranges are not silently clamped.

A trim must be followed by a supported export or thumbnail terminal.
Metadata accepts no preceding transformations.

## Consecutive ranges

Each trim refers to the result of preceding trims, rather than independently
referring to the original source.

For example:

    const result = await client.from(input)
      .trim({ start: 1.25, end: 3.75 })
      .trim({ start: 0.5, end: 1.5 })
      .convert({ format: "mp4", preset: "video-balanced-v1" })
      .export({ output: { kind: "bytes" } });

The first logical clip spans source seconds 1.25 to 3.75.
The second trim resolves to source seconds 1.75 to 2.75.

Every intermediate range is validated against its preceding logical duration.
Resolved absolute bounds must remain finite and distinguishable.

## Timing profile and precision

The current filter path requires a detected source origin of exactly zero.
Unknown or nonzero origins reject as unsupported.

Resolved trim bounds must round-trip exactly through safe-integer microseconds.
Requests that cannot preserve that precision reject instead of being rounded.
This check applies after consecutive ranges have been resolved; floating-point
addition can affect whether a resolved bound passes.

Native and Browser share range resolution and timing filters.
For MP4 video, Native uses the filter time-base spelling while Browser uses
the equivalent explicit 1:1000000 rational supported by its pinned core.

## Selection and output timestamps

The filters select retained video frames and audio samples from the requested
start-inclusive, end-exclusive interval.

The requested start is subtracted from both video and audio timestamps.
Each stream is not independently reset to its first retained timestamp.
This preserves relative timing between retained streams.

A first retained video frame can therefore have a positive output timestamp.
For example, a frame at source time 0.166667 selected by a trim starting at
0.125 appears near output time 0.041667.

The requested interval, selected source content, encoded stream duration,
container duration, and decoded sample count are related but distinct.
The API does not promise that each equals end minus start exactly.

## Selection analysis

Before encoding a trim, the implementation checks actual selected content.

For video output:

- At least one video frame must be selected.
- When selected audio is required, at least one audio sample frame must exist.
- Video-only input does not gain synthetic audio.

For audio output, analysis verifies the selected audio interval before encoding.

An audio sample frame contains one sample for each channel.
For example, 6000 stereo sample frames contain 6000 samples per channel,
rather than 6000 samples divided between both channels.

Counts must come from successful, validated analysis.
Malformed, incomplete, or failed analysis must not be classified as an empty
successful selection.

A nonempty time range can select no usable content. That rejects with
INVALID_OPTIONS and reason RANGE_TOO_SHORT.

## Codec padding

Source sample selection and decoder-visible codec padding are separate issues.
AAC and MP3 framing, delay, and decoder behavior can affect observed durations
or sample counts. WAV PCM is uncompressed.

Passing exact-count fixtures do not establish padding-free output for all
engine builds or consuming decoders. Preserve the capability disclosure of
decoder-dependent AAC padding.

The tested trimmed PCM outputs match the selected source samples exactly.
That evidence does not generalize to byte identity for lossy encodings.

## Failure behavior

| Condition                                            | Handling                         |
| ---------------------------------------------------- | -------------------------------- |
| Invalid numeric range or end beyond logical duration | INVALID_OPTIONS                  |
| Unknown/invalid required duration                    | INVALID_MEDIA                    |
| Resolved interval lost through numeric precision     | UNSUPPORTED_CAPABILITY           |
| Unknown/nonzero supported-path origin                | UNSUPPORTED_CAPABILITY           |
| Bounds cannot round-trip through microseconds        | UNSUPPORTED_CAPABILITY           |
| Missing timing filters or analysis components        | UNSUPPORTED_CAPABILITY           |
| Valid analysis selects no required content           | INVALID_OPTIONS; RANGE_TOO_SHORT |
| Malformed selection counts or failed analysis        | Structured execution failure     |

The first failing validation determines the reported error.
Some checks occur during plan validation and others during preparation.
Do not promise one exact internal reason identifier across every route.

## Lifecycle

Existing acceptance checks verify rejection before successful output publication,
same-client recovery after empty-selection rejection, source preservation,
cleanup, and valid returned output after disposal.

Native path output retains overwrite protection.
Browser output uses bytes or Blob; Native output uses bytes or paths.
Cancellation and publication follow the existing client lifecycle contract.

## Evidence

Reviewed source:

- shared/trim-range.ts
- shared/trim-filters.ts
- shared/audio-trim-filters.ts
- shared/trim-counts.ts
- shared/trim-selection.ts
- browser/trim-plan.ts
- browser/audio-trim-plan.ts

Paths above are relative to packages/mavio/src/engines/.

Existing passing tests cover consecutive ranges, unknown duration, bounds,
microsecond precision, source origins, missing filters, sample-frame counts,
malformed evidence, and empty selections.

Real Native acceptance passed fractional/consecutive video and audio trimming,
source-frame selection, selected audio samples, PCM identity, recovery,
overwrite protection, and cleanup.

Installed-package Browser acceptance passed fractional/consecutive MP4 and
audio trims, empty-selection recovery, exact trimmed PCM fixtures, and output
decoding after disposal. Public combined trim/resize also passed under M5-04.

The last registered test run passed 894 SDK tests and eight helper tests.
No production trim change was required for M5-03.
This evidence applies to the tested media and timing profiles.
Fresh cross-platform CI remains required for release acceptance.
