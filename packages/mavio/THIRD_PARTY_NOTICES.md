# Third-party notices

## Mavio SDK

Mavio's own SDK code is provided under the MIT license in LICENSE.

## FFmpeg WebAssembly wrapper and types

The SDK depends on @ffmpeg/ffmpeg 0.12.15 and @ffmpeg/types 0.12.4.
Their MIT notice is preserved in third-party/ffmpegwasm-MIT.txt.

Notice source: ffmpegwasm/ffmpeg.wasm, tag v12.15, commit
71aa99d37c02a7b4c435275ca9ef50e612f6efa1.
That tag declares these versions. Published npm metadata omits gitHead;
this attribution is not a reproducible-package provenance claim.

## Media engines

Native FFmpeg/FFprobe executables and Browser engine binaries are not
included in the SDK archive.

Normal Browser generation requires the separately supplied pinned v2 kit.
Its FFmpeg build enables GPL components, including x264, and incorporates
other libraries and runtime material with their own notices.
Generated output includes the pinned source archive and collected notices.
See third-party/ENGINE-LICENSING.md and the generated modification record.

The original npm core is no longer a normal-generation fallback.
The separate experimental v1 command remains available for evaluation.

Engine redistribution acceptance and the consuming application's obligations
are not established by Mavio's MIT declaration or passing functional tests.
M7-L01 remains open. No public publication approval is recorded here.
