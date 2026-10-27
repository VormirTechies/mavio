# Changelog

## [0.0.3] — Release preparation

Publication is pending. This entry summarizes the M2–M7 implementation
included in the current 0.0.3 release candidate.

### Added

- Default Native FFmpeg/FFprobe and Browser WebAssembly adapters.
- Source metadata, MP4 video export and trim, resize, compression, preset
  quality selection, audio export and trim, audio-track selection, and thumbnails
  within the reviewed runtime and media profiles.
- Installed-consumer examples and checks for cancellation, cleanup, recovery,
  and bounded resource behavior.
- Required hash-pinned v2 Browser engine kit, JavaScript stack restoration,
  corresponding-source delivery, modification records, and component notices.
- Restricted Native input demuxers and selected-field diagnostic events.

### Acceptance and limitations

- M7 acceptance identifies the reviewed candidate and release-scoped owner
  dispositions. Remaining follow-up is required before the next release.
- Browser acceptance covers the tested Chromium configurations.
- Native tools are installed separately; their provenance and maintenance
  remain the responsibility of the distributing application or operator.
- Browser engine binaries are supplied separately from the MIT SDK.
- Public engine delivery and npm publication remain M8 work.
- Hosted documentation, landing page, and comprehensive demo are not included
  in this SDK release preparation.

### M2 core implementation history

- Added public Node and browser client factories with explicit adapter ownership and lazy initialization.
- Implemented immutable pipelines, preset/composition validation, source preflight, and runtime input/output restrictions.
- Added serialized scheduling, queue limits, cancellation, initialization deadlines, disposal, and retry after successful cleanup.
- Implemented publication gating, ordered progress, observer isolation, and protection against late or reentrant callbacks.
- Preserved primary failures through cleanup and retained valid cleanup warnings on successful results.
- Added adapter-response validation, independent output snapshots, and Node path resolution.
- Expanded the runtime suite to 161 tests, including browser Blob-to-video and Node path-to-audio mock-adapter acceptance flows.

### Historical M2 scope

The following describes the earlier M2 checkpoint, not the current release candidate.

- An explicit engine adapter is required. Default and automatic engines remain pending.
- Native FFmpeg integration belongs to M3; browser ffmpeg.wasm integration belongs to M4.
- Mock tests verify orchestration, not actual media processing or filesystem publication.
- Complete real-media operation conformance remains assigned to M5.
- Documentation and playground applications remain placeholders.
- The SDK remains private and unpublished.

## [0.0.2] — M1 foundation

- Established the SDK workspace and private docs/playground workspace packages.
- Added TypeScript builds, public contract types, and browser/Node package entry points.
- Added consumer type checks, export tests, archive installation checks, browser bundling, and a Chromium import smoke test.
- Added Windows/Linux CI on Node 22 and 24.
- Added linting, formatting, consistent LF line endings, contributor instructions, and fixture conventions.

### Scope and limitations

- Docs and playground packages are placeholders, without runnable applications.
- Media fixtures are planned but not yet populated.
- Core behavior, media operations, and engine adapters remain unimplemented.
- FFmpeg worker-asset verification moves from M1 to M4, alongside browser adapter implementation.
- The SDK remains private and has not been published to npm.

## v0.0.1 — M0 discovery and contracts

- Established the approved browser/Node SDK scope and TypeScript API/engine contracts.
- Defined six versioned presets and native/browser initialization behavior.
- Resolved 32 edge-case scenarios, including publication/cancellation races and cleanup warnings.
- Recorded bounded metadata, trim, preset and initialization experiments plus consumer type checks.
- Completed the specification milestone; implementation starts with the M1 foundation.

See [release notes and known limitations](docs/m0/RELEASE-NOTES.md). This milestone does not publish an npm SDK.
