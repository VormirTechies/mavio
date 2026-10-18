# M3 native validation

Evidence recorded: 2026-10-19.

## Verified configurations

The project owner reported passing native acceptance checks for:

| Platform | Architecture | Node    | FFmpeg / FFprobe                    |
| -------- | ------------ | ------- | ----------------------------------- |
| macOS    | arm64        | 22.23.2 | 9.0.1                               |
| Windows  | x64          | 22.23.3 | 9.0.2-essentials_build-www.gyan.dev |
| Ubuntu   | x64          | 22.23.3 | 6.1.1-3ubuntu5                      |

These results apply to the tested configurations and fixtures.
They do not establish compatibility with every FFmpeg build,
operating-system version, architecture, or input profile.

Node 24 jobs are configured in CI. Their exact versions and final
results remain to be recorded.

## Verified acceptance areas

- Native tool discovery and codec/filter inventory.
- Metadata probing and invalid-media rejection.
- Balanced and small MP4 presets.
- Video trim, resize, and combined processing.
- MP3 and PCM WAV audio export and trim.
- JPEG and PNG thumbnails, including consecutive resize.
- Thumbnail frame selection against an independent reference.
- Path and byte inputs/outputs on the exercised routes.
- Overwrite protection, recovery, source preservation, and cleanup.
- Returned outputs remain usable after workspace or client disposal.

## AAC timing limitation

The fractional MP4 fixture requests 47,040 audio samples at 48 kHz.

On the tested Ubuntu configuration, the combined-output check observed
47,104 decoded samples. The revised acceptance check requires:

- An audio start timestamp of zero.
- A declared audio duration of exactly 47,040 samples.
- Continuous decoded timestamps.
- Any excess samples to be confined to the final overlapping AAC frame,
  with the fixture-specific frame-boundary checks passing.

This verifies presentation timing for the fixture. It does not establish
sample-exact AAC decoding across the tested toolchains.

Do not describe this behavior as universally sample-exact. Capability
handling for the limitation remains an M3 release gate under the approved
timing contract.

## AAC Capability-policy

The native MP4 presets disclose decoder-dependent AAC padding through
`EngineCapabilities.encodings[].audioPadding`. This policy preserves valid
exports while making the decoded-sample-count limitation discoverable.
The declaration is conservative across native tool versions and does not
claim universal sample-exact AAC decoding.

## Remaining closeout gates

- Record the Node 24 native job versions and results.
- Confirm all 10 CI jobs passed for the same commit.
