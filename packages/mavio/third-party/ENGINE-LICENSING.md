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
Final notice completeness and distribution-model review remain M7-L01 work.
Review storage is an unpublished GitHub draft, not a public delivery channel.

The separate experimental v1 command retains its own pins and generated guide.
No public publication is authorized by this document.
