# M7 licensing and redistribution review

## Status

Open. Notice preservation is implemented locally; complete engine
redistribution clearance has not been established.

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
