# M7 Native security review

## M7-N01: Referenced local files during metadata probing

Status: Mitigated locally for the demonstrated reference-input route; final regression and CI acceptance remain pending.

A controlled public-client probe accepted an ffconcat manifest referencing a
synthetic neighboring WAV file. The returned container was concat, with a
pcm_s16le audio stream at 48000 Hz, mono.

The control WAV probe succeeded, and both fixture files remained unchanged.
All fixtures were created inside a new temporary directory. No unrelated
application or system files were used.

The observation demonstrates that the Native file protocol allowlist does not
restrict reads to the explicitly supplied input file. It does not demonstrate
arbitrary-file disclosure, network access, shell execution, or code execution.

A caller supplying untrusted media must not assume single-file confinement
from the protocol allowlist. FFprobe runs with the application's operating-system
permissions. Metadata probing occurs before export source-profile validation.

Remaining assessment:

- Determine the intended policy for reference-bearing containers.
- Inspect available demuxer restrictions and reference-handling options.
- Assess nested references; rejecting concat alone would not establish confinement.
- Preserve supported standalone metadata and processing routes.
- Distinguish SDK validation from deployment-level filesystem isolation.
- Add reproducible regression evidence for any selected mitigation.

Do not close this finding solely by renaming input files, checking extensions,
or documenting the protocol allowlist as a filesystem sandbox.

## Publication boundary verification

The focused Native review run passed 76 tests with no failures or skips.

Four added publication cases verify rejection of empty-file and directory staging
before commit, preservation of a destination created immediately before linking,
and preservation of an existing hard-link alias.

Formatting, targeted lint, and diff whitespace checks passed.
These checks do not resolve M7-N01 or establish complete filesystem security.

## Restricted Native input policy — 2026-10-24

The project owner approved restricting default Native formats and deferring
broad metadata support to future work.

Processing inputs use a shared demuxer allowlist:

- mov, including its MP4/M4A/3GP/3G2/MJ2 aliases.
- matroska, including WebM.
- wav, mp3, and flac.
- jpeg_pipe and png_pipe.

The policy is applied before input opening in probing, encoding commands,
trim analysis, and thumbnail frame analysis. The file protocol allowlist remains.

FFprobe metadata and output-readback probing additionally permit image2 with
pattern_type none. Generated JPEG thumbnails can select image2 rather than
jpeg_pipe. Filename-pattern expansion is disabled for this probe-only route;
image2 is not added to processing-command demuxers.

MOV external-reference options retain the inspected disabled defaults.
No public option enables broad demuxer support or overrides the policy.

Native readableContainers now reports discovered names intersected with the
restricted metadata policy. The installed engine's complete demuxer inventory
is not the public acceptance policy. A readable container does not guarantee
support for every encoding plan or source profile.

### Regression evidence

- The initial unrestricted public probe accepted a synthetic concat manifest
  and returned its referenced WAV stream.
- The permanent verifier confirms that unrestricted FFprobe accepts its control
  manifest before testing SDK rejection.
- The SDK rejects concat path input, disguised-extension path input, byte input,
  and an explicit WAV export request.
- Same-client recovery and source preservation pass.
- WAV, FLAC, MP3, MP4, Matroska, JPEG, PNG, and a literal pattern-like image
  filename pass public metadata probing for path and byte inputs.
- A forced image2 sequence control reads two image packets; the restricted
  single-file control reads one packet from the literal filename.
- Eleven probe tests pass, including argument placement, capability filtering,
  and immutable policy constants.
- The earlier Native regression run passed 409 tests before the probe-only
  image2 refinement. Final regression must cover the final policy.
- Video, compression, preset quality, audio, and thumbnail checks passed during
  investigation. The complete final suite remains to be rerun.
- Targeted production/verifier lint passed.

The permanent real-engine verifier is registered in check:native:all, which
existing Native CI jobs exercise across supported platforms.

### Compatibility and residual boundaries

Standalone FLAC remains accepted because existing audio acceptance uses it.
Playlist and reference-bearing formats such as concat, HLS, and DASH are not
admitted by the default demuxer policy.

The restriction does not sandbox FFmpeg/FFprobe, authenticate Native binaries,
confine process filesystem permissions, prevent parser vulnerabilities, or
establish complete nested-reference safety for every accepted container.

Applications must control executable provenance, filesystem authorization,
directory ownership, workload limits, and isolation when processing hostile
media. Final cross-platform verification and dependency review remain required.

## Final local Native acceptance

The final check:native:all run passed all seven registered checks on Windows
x64 with Node v24.22.1 and FFmpeg/FFprobe 9.0.2 essentials.

This supersedes the earlier pending complete-suite statements in this review.
Fresh cross-platform CI and final milestone regression remain pending.
