# Changelog

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
