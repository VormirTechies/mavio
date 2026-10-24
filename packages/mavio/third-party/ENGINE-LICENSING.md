# Generated engine licensing

## Included notices

- ffmpegwasm-MIT.txt preserves the upstream wrapper copyright and MIT terms.
- GNU-GPL-2.0.txt provides the GPL version 2 license text.
- manifest.json records hashes of these notices and the generated assets.

The wrapper package declares MIT. The pinned @ffmpeg/core 0.12.10 package
declares GPL-2.0-or-later. Its compiled FFmpeg and external libraries have
their own applicable licenses. These assets are not all licensed under MIT.

## Modification record

Mavio modifies the pinned core JavaScript to restore the WASM stack after
both native entry points. The generator leaves the upstream WASM unchanged.
The SDK's scripts/browser-assets.mjs contains that JavaScript correction.
This document describes the production generator, not the experimental core.

## Redistribution assessment remains open

These files do not form a complete engine compliance bundle. Before distributing
or hosting the generated engine, establish corresponding source for the actual
binary, preserve applicable component notices, include modifications and build
instructions, and assess the license requirements of the intended distribution.

A manifest, npm package URL, or generic upstream repository link does not by
itself establish complete corresponding-source delivery. Mavio does not currently
certify that the upstream core's exact build source has been established.

References:

- https://ffmpegwasm.netlify.app/docs/faq/
- https://ffmpeg.org/legal.html
- https://github.com/ffmpegwasm/ffmpeg.wasm

The experimental updated core is not adopted by this generator.
Security acceptance and redistribution review remain separate open gates.
