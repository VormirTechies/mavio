# Browser engine licensing and source delivery

## Normal generation

Normal mavio-browser-assets generation requires the pinned v2 engine kit:
ffmpeg-5.1.10-mavio-x264-cleanup-v2.
The original @ffmpeg/core 0.12.10 package is not a fallback.

Generated output includes the engine, wrapper modules, notices/, sources/,
a modification record, and a hash manifest. Preserve these materials together.
The generated ENGINE-LICENSING.md describes that specific output.

Mavio's SDK code remains MIT. That declaration does not replace the separate
licenses of FFmpeg, x264, LAME, zlib, bindings, or runtime components.
The v2 build enables GPL components. Component and runtime license texts
are preserved in the kit's notice collection and complete source material.

## Modification and source records

The source archive preserves pinned source snapshots, build recipes,
command-line maintenance changes, runtime-export changes, the zlib patch,
and the local x264 parameter-cleanup patch.
Generated JavaScript restores the stack after both native entry points.
The generator copies the compiled WASM unchanged.

## Acceptance boundary

The reviewed source archive reconstructed the tested binaries. Its later
acceptance-metadata refresh preserved all recorded build-material hashes.
Installed generation and cross-platform verification passed.

These technical checks do not themselves establish complete licensing
clearance for every consuming application or distribution.
M7 acceptance for SDK 0.0.3 includes release-scoped owner dispositions and
distribution conditions. These decisions do not waive license obligations
or carry forward automatically to another release.

M8 must verify the final public distribution notice set and durable delivery
of the actual engine and corresponding source before publication.
The current unpublished GitHub draft remains a review channel.

Preserve the supplemental musl-EMBEDDED-NOTICES.txt supplied by the SDK
generator, together with the kit notices, source archive, and modifications.

The separate experimental v1 command retains its own pins and generated guide.
No public publication is authorized by this document.
