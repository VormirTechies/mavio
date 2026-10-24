# Third-party notices

## Mavio SDK

Mavio's own SDK code is provided under the MIT license in LICENSE.

## FFmpeg WebAssembly wrapper and types

The SDK depends on @ffmpeg/ffmpeg 0.12.15 and @ffmpeg/types 0.12.4.
Their package declarations identify the MIT license.

The upstream MIT copyright and permission notice is preserved in
[third-party/ffmpegwasm-MIT.txt](third-party/ffmpegwasm-MIT.txt).

Notice source: ffmpegwasm/ffmpeg.wasm, tag v12.15, commit
71aa99d37c02a7b4c435275ca9ef50e612f6efa1.
The tag declares these package versions. Published npm metadata omits gitHead;
this notice attribution is not a claim of reproducible package provenance.

## Media engines

FFmpeg/FFprobe executables and Browser core JS/WASM are not included in this
SDK archive. Their licenses are separate from Mavio's MIT license.

The currently supported upstream @ffmpeg/core package declares
GPL-2.0-or-later. The experimental candidate also enables GPL components,
including x264, and incorporates libraries with additional license notices.

Generating, copying, hosting, or redistributing engine assets requires a
separate assessment of the actual build, notices, modifications, and source
delivery. This SDK notice does not establish engine-distribution compliance
or determine the license obligations of a consuming application.

The experimental candidate remains unaccepted. Its security and licensing
reviews do not authorize publication or production adoption.
