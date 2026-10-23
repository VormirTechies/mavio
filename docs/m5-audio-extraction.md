# M5 audio extraction

## Selection

extractAudio() selects the first audio stream in source metadata order.
It does not select by the lowest numeric stream index.

extractAudio({ streamIndex }) selects an absolute source stream index.
The index must be a nonnegative safe integer identifying an audio stream.
It is not an ordinal within the audio streams.

For a source with video at index 0 and audio at indexes 1 and 2:

- Default extraction selects index 1.
- Explicit streamIndex: 2 selects the second audio track.
- Explicit streamIndex: 0 rejects because it identifies video.
- An absent index rejects without falling back.

Extraction adds a pipeline transformation. It does not execute until export.

## Output

Choose an approved audio format and preset:

| Format | Preset            | Codec                               |
| ------ | ----------------- | ----------------------------------- |
| MP3    | audio-balanced-v1 | libmp3lame; target bitrate 128 kb/s |
| WAV    | audio-pcm-v1      | pcm_s16le                           |

Output contains one selected audio stream.
A video encoding preset conflicts with audio extraction.
Duplicate extraction declarations are rejected.

Example, assuming a configured client and compatible input:

    const result = await client.from(input)
      .extractAudio({ streamIndex: 2 })
      .convert({ format: "wav", preset: "audio-pcm-v1" })
      .export({ output: { kind: "bytes" } });

Native supports path/byte inputs and outputs.
Browser supports byte/Blob inputs and outputs.
Dispose the client after its work completes.

## Supported audio profile

Both runtimes share rate and layout validation:

- Preserve supported sample rates: 44100 or 48000 Hz.
- Preserve mono/one-channel or stereo/two-channel layout.
- Reject unknown, contradictory, multichannel, or unsupported profiles.
- Infer missing mono/stereo layout only for pcm_s16le in a source whose
  normalized container is exactly wav.
- Do not silently resample or downmix an unsupported profile.
- Browser additionally requires the selected source decoder in its inventory.

An unselected video stream does not need to satisfy the MP4 video-output
profile for an audio-only conversion.

Decoded PCM represents the selected decoded source content.
Converting lossy input to PCM does not restore lost detail.
Codec padding and consuming decoder behavior remain relevant to duration
and sample-count interpretation.

## Failures and recovery

| Case                                                 | Expected rejection                                    |
| ---------------------------------------------------- | ----------------------------------------------------- |
| Explicit video or absent stream index                | INVALID_OPTIONS; INVALID_STREAM_INDEX                 |
| Valid video-only input with default audio conversion | INVALID_MEDIA; MISSING_AUDIO                          |
| Valid video-only input with extractAudio()           | INVALID_MEDIA; MISSING_AUDIO                          |
| Unsupported selected rate/layout                     | UNSUPPORTED_CAPABILITY                                |
| Missing required Browser source decoder              | UNSUPPORTED_CAPABILITY                                |
| Malformed media                                      | Structured media/probe failure according to the route |

Validation order determines the first reported failure.
A rejected request must not fall back to another track or publish a
successful result. Existing acceptance checks verify same-client recovery.

Trim can precede or follow extraction within the supported audio plan.
Resize after extraction is rejected. See m5-trim.md for timing semantics.

## Acceptance evidence

Previously completed Native acceptance verified both audio presets,
default selection at 48000 Hz mono, explicit second-track selection at
44100 Hz mono, invalid/video indexes, missing audio, and recovery.

The focused Browser audio-selection-public check passed on Windows x64,
Node v24.22.1, Chrome/Chromium 156.0.8078.47, with generated corrected assets.

The Browser fixture contains video at index 0 and distinct AAC tracks:
48000 Hz mono at index 1 and 44100 Hz mono at index 2.

For each output preset, acceptance covers:

- Default and explicit second-track selection across byte/Blob input/output:
  eight outputs per preset.
- Recovery after video index, absent index, missing-audio default conversion,
  and missing-audio extraction rejection: four outputs per preset.
- All 24 returned outputs decoded after public-client disposal.
- PCM outputs exactly matched independently decoded selected source tracks.
- Caller content preservation, workspace cleanup, and worker shutdown.

Existing stereo export and WAV re-input acceptance remain complementary
coverage. The new selection check is registered in the verified Browser suite,
bringing that suite to ten checks.

No production SDK implementation changed under M5-05.
Evidence covers the tested profiles and does not replace fresh cross-platform CI.
