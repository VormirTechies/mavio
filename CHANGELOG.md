# Changelog

## [0.0.3] — M2 core

- Added public Node and browser client factories with explicit adapter ownership and lazy initialization.
- Implemented immutable pipelines, preset/composition validation, source preflight, and runtime input/output restrictions.
- Added serialized scheduling, queue limits, cancellation, initialization deadlines, disposal, and retry after successful cleanup.
- Implemented publication gating, ordered progress, observer isolation, and protection against late or reentrant callbacks.
- Preserved primary failures through cleanup and retained valid cleanup warnings on successful results.
- Added adapter-response validation, independent output snapshots, and Node path resolution.
- Expanded the runtime suite to 161 tests, including browser Blob-to-video and Node path-to-audio mock-adapter acceptance flows.

### Scope and limitations

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
