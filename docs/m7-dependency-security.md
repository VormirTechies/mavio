# M7 dependency security assessment

## Status

Open. Browser compiled-engine exposure requires resolution before release
acceptance. No dependency upgrade or security exception has been approved.

## npm advisory and provenance evidence

On 2026-10-24, npm 11.19.1 reported zero known vulnerabilities for both the
production workspace audit and the full workspace audit.

Raw evidence:

- [Production audit](security/m7-npm-production-2026-10-24.json).
- [Workspace audit](security/m7-npm-workspace-2026-10-24.json).

Registry signature verification passed for 108 packages.
Thirty-five packages had verified attestations.

Installed versions matched lockfile versions:

| Package        | Version | Declared license |
| -------------- | ------- | ---------------- |
| @ffmpeg/ffmpeg | 0.12.15 | MIT              |
| @ffmpeg/types  | 0.12.4  | MIT              |
| @ffmpeg/core   | 0.12.10 | GPL-2.0-or-later |

Lockfile entries use registry.npmjs.org URLs and include SHA-512 integrity values.
Package signatures and attestations do not establish vulnerability freedom or
licensing compliance. Licensing assessment remains M7-06.

## M7-D01: Browser compiled-engine fixes unverified

Status: Open; release acceptance blocked pending assessment and resolution.

The generated Browser core reported FFmpeg 5.1.4 in Chromium 153.0.8010.12.
The inspection checked core JS/WASM against the generated manifest and used
the actual Browser worker. The worker was terminated after inspection.

Reported library versions include:

- libavutil 57.28.100.
- libavcodec 59.37.100.
- libavformat 59.27.100.
- libswresample 4.7.100.

The build configuration enables GPL components, x264, x265, libvpx, LAME,
Theora, Vorbis, Opus, zlib, WebP, FreeType, FriBidi, libass, and zimg.
Those component versions and their advisories also require assessment.

The [official FFmpeg security record](https://www.ffmpeg.org/security.html)
lists fixes in releases after 5.1.4. Initial fix inspection identified:

| Candidate      | Changed component    | Upstream fix                             |
| -------------- | -------------------- | ---------------------------------------- |
| CVE-2024-35366 | SBG demuxer          | 4db0eb4653efad967ddcf71f564fd2f1169bafcb |
| CVE-2024-36613 | DXA demuxer          | 1f6fcc64179377114b4ecc3b9f63bd5774a64edf |
| CVE-2024-36616 | Westwood VQA demuxer | a8beef67993aa267de87599007143d9f0ba67c23 |
| CVE-2024-36617 | CAF demuxer          | f0e780370cc1c437d64f10d326b1d656ef490b5f |
| CVE-2024-7055  | PNM-family decoder   | 5372bfe01e4a04357ab4465c1426cf8c6412dfd5 |
| CVE-2024-7272  | Audio resampling     | a937b3c58babae893fb46b286a4792cd24a01d3d |

Commit details were retrieved from the official FFmpeg/FFmpeg repository API.
The runtime inventory contains caf, dxa, sbg, and wsvqa demuxers, PNM-family
decoders, and libswresample.

These are assessment candidates, not a demonstrated exploit or a complete CVE
list. Version and component inventory alone do not prove whether a fix was
backported, whether vulnerable code survived compilation, or whether a particular
input reaches it in this WASM build.

## Required resolution

- Establish exact source/build provenance and any security backports.
- Assess later upstream fixes and enabled third-party libraries.
- Evaluate maintained replacement builds or a reproducible updated core.
- Do not treat the JavaScript stack-restoration correction as a security update
  to the unchanged WASM.
- Do not treat the Native demuxer restriction as protection for Browser inputs.
- Do not close the resampling assessment merely by blocking obscure demuxers.
- Revalidate hashes, generation, stack regression, supported routes, and fresh
  installed consumers if the core changes.

Separately installed Native binaries need their own provenance and maintenance
assessment. Their version and distribution differ from the Browser core.

Existing functional acceptance remains historical evidence for the tested
configuration. It does not clear this dependency assessment or authorize release.

## Experimental candidate compatibility evidence

The experimental FFmpeg 5.1.10 candidate passed local Windows Browser compatibility checks on 2026-10-24. Both corrected stack controls restored their starting stack positions. Two complete 612-call replays decoded successfully and matched the 6,144-sample reference PCM.

Nine Browser checks passed: default, public resize, compression, preset quality, audio export, audio selection, audio trim, thumbnail export, and cancellation. These checks used the current workspace SDK build with separately staged candidate assets.

Hashes, source pins, and results are recorded in [the candidate evidence](security/m7-browser-core-candidate-2026-10-24.json).

M7-D01 remains open. This evidence establishes compatibility for the tested local profile; dependency security review, licensing, production integration, installed-package acceptance, and required CI remain pending.

## Candidate source checks for six identified fixes

Five identified fixes passed reverse-patch checks against the pinned candidate source. CVE-2024-7272 required manual inspection because its new-layout validation was subsequently extracted into swri_check_chlayout. Inspection confirmed rejection of invalid layouts and excessive channel counts before copying, with the original legacy-branch guards retained.

Results and the reviewed source hash are recorded in [the source-check evidence](security/m7-candidate-ffmpeg-fix-checks-2026-10-24.json). This covers six identified fixes only. Broader advisory review, third-party dependency assessment, and production adoption remain open under M7-D01.

## Consolidated candidate assessment — 2026-10-24

The experimental candidate has the following bounded evidence:

- Listed FFmpeg fixes were checked through reverse-patch checks or manual source review.
- The zlib CVE-2026-85091 patch is applied in the build recipe and verified in exported build source. Generated JS/WASM remain byte-identical to the locally tested candidate.
- FFmpeg SDL support and its SDL output device are disabled. This supports route-specific containment, not absence of every SDL component.
- Twelve security-relevant LAME files match the upstream 3.100 release archive after line-ending normalization. The pinned history includes relevant fixes; independent release-signature verification was not performed.
- The x264 encoder-initialization cleanup finding remains open. Mavio rejects encoding failures and discards the worker; 25 existing termination tests passed. This mitigation does not repair x264 or establish candidate-specific exploitability.

Evidence:

- [FFmpeg initial checks](security/m7-candidate-ffmpeg-fix-checks-2026-10-24.json)
- [FFmpeg additional checks](security/m7-candidate-additional-ffmpeg-fixes-2026-10-24.json)
- [zlib build verification](security/m7-candidate-zlib-patch-build-2026-10-24.json)
- [SDL route assessment](security/m7-candidate-sdl-route-assessment-2026-10-24.json)
- [LAME release comparison](security/m7-candidate-lame-release-comparison-2026-10-24.json)
- [x264 containment](security/m7-candidate-x264-containment-2026-10-24.json)

M7-D01 remains open. No security exception or release approval is recorded.
The production asset generator still uses the original core. Candidate adoption,
remaining dependency dispositions, licensing, installed-package acceptance, and
required CI remain pending. Other M7 reviews can proceed independently.

## Candidate build traceability — 2026-10-25

A fresh prepared source context and a separately reconstructed source bundle
both produced the tested candidate JavaScript and WASM hashes. The bundle
reconstruction result is recorded in
[the reconstruction evidence](security/m7-source-bundle-reconstruction-2026-10-25.json).

This strengthens source/build traceability for the experimental candidate.
It does not resolve the x264 cleanup finding, establish vulnerability freedom,
or approve production adoption. M7-D01 remains open.
