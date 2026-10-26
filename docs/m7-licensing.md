# M7 licensing and redistribution review

## Status

Reviewed candidate distribution model accepted for 0.0.3 only, subject to
preserving applicable obligations and verifying public delivery during M8.
This is not a license waiver or blanket consuming-application clearance.

## Reviewed components

| Component                     | Observed license evidence                                                       |
| ----------------------------- | ------------------------------------------------------------------------------- |
| Mavio SDK                     | MIT; package LICENSE                                                            |
| @ffmpeg/ffmpeg 0.12.15        | MIT declaration; notice preserved from version-matching upstream tag            |
| @ffmpeg/types 0.12.4          | MIT declaration; same upstream notice preserved                                 |
| Original @ffmpeg/core 0.12.10 | GPL-2.0-or-later declaration                                                    |
| Candidate binding code        | Upstream MIT LICENSE                                                            |
| Candidate FFmpeg              | GPL-enabled configuration; upstream license documentation                       |
| Candidate x264                | GPLv2 text and source license notices                                           |
| Candidate LAME                | Library GPL version 2-or-later source notice; COPYING and LICENSE               |
| Candidate zlib                | Upstream zlib license                                                           |
| Requested SDL2 port           | Emscripten port identifies zlib license; complete port notice inventory pending |

This table records inspected evidence rather than determining every obligation
of a consuming application or distribution.

## Implemented notice preservation

The SDK package includes THIRD_PARTY_NOTICES.md and third-party license files.
The asset generator includes the wrapper MIT notice, GPLv2 text, and
ENGINE-LICENSING.md in its manifest-backed output.

Generated notice existence and hashes passed local verification.
Existing asset-generator regression tests passed after the change.

The generated guide identifies the JavaScript stack-restoration modification.
It explicitly states that the notices do not form a complete compliance bundle.

## M7-L01: Engine source delivery and notice completeness

Status: Open; engine redistribution acceptance remains blocked.

The original npm core lacks gitHead metadata. A similarly named repository
tag did not identify compatible FFprobe bindings during candidate investigation.
Exact corresponding source for the published original binary is not established.

The experimental candidate has pinned source commits, build recipes, maintenance
changes, runtime-export changes, and a zlib security patch. These are useful
provenance evidence, but complete source-delivery packaging and all component
notices remain to be verified before candidate distribution.

A generic repository link, license file, or hash manifest is not treated as
proof that complete corresponding source is delivered for a particular binary.

## Remaining work

- Establish the engine selected for any release and its exact distribution scope.
- Complete the applicable component notice and source-delivery bundle.
- Record modifications and the build material needed for that engine.
- Verify notices through fresh installed-package asset generation.
- Assess separately distributed Native binaries using their actual build licenses.
- Review the intended application/distribution model before claiming compliance.

Mavio's MIT declaration does not replace engine licenses.
No engine redistribution exception, production adoption, or publication approval
is recorded. M7-D01 remains open independently.

## Candidate source-delivery verification — 2026-10-25

A local candidate source archive now contains the five pinned component
source archives, build recipes and modifications, Emscripten source material,
and the SDL archive verified against the pinned Emscripten port.

Reconstruction from that archive successfully built the tested candidate
JavaScript and WASM hashes. Docker cache was permitted; this does not establish
cache-free, offline, or cross-host reproducibility.

Component root licenses and notices were collected separately, including
Emscripten, musl, compiler-rt, libc++, libc++abi, and SDL material.
Embedded per-file notices and the final distribution notice set still require
review. The source archive remains a local review artifact; durable delivery
with any distributed engine has not been established.

Evidence:

- [Source reconstruction](security/m7-source-bundle-reconstruction-2026-10-25.json).
- [Notice collection](security/m7-candidate-notice-collection-2026-10-25.json).

M7-L01 remains open. Candidate adoption, final notice completeness,
source-delivery arrangements, and installed-package verification remain pending.
The production generator still selects the original npm core.

## Current v2 release scope — 2026-10-26

This section supersedes earlier statements that normal generation selects
the original npm core or that v2 source delivery has not been assembled.

The project owner approved v2 as the required normal Browser generation route.
The SDK archive contains generation code and pins, not engine binaries.
The separately supplied kit contains the pinned binaries, source archive,
collected component/runtime notices, and modification record.

Source reconstruction, corrected evidence refresh, installed generation,
and all required-v2 CI jobs passed. The archive is held in an unpublished
GitHub draft and has been downloaded and hash-verified by CI.

Evidence:

- [Source metadata refresh](security/m7-candidate-v2-source-metadata-refresh-2026-10-25.json).
- [Pinned kit contents](security/m7-candidate-v2-engine-kit-2026-10-25.json).
- [Required-v2 CI](security/m7-required-v2-ci-2026-10-26.json).

M7-L01 remains open for final notice completeness and intended-distribution
review. A public source/binary delivery channel is not yet approved.
Separately installed Native tools remain application-managed; no Native
executable distribution is added to the SDK package.

Earlier records remain historical evidence. No general consuming-application
licensing clearance, security exception, or public publication is implied.

## Release-scoped distribution-model decision — 2026-10-26

The owner approved the reviewed 0.0.3 candidate distribution model:
MIT SDK separately from the GPL-enabled engine, preserving the generated
source archive, notices, and modification records together.

M7-L01 has an accepted candidate-model disposition subject to those conditions.
This supersedes earlier statements that no owner decision exists. It does not
waive license requirements or approve every consuming application's distribution.

Public binary/source delivery must be verified during M8 before publication.
The remaining notice-completeness and distribution review must be revisited
before the next release. No approval carries forward automatically.

[Decision record](security/m7-owner-dispositions-2026-10-26.json).
