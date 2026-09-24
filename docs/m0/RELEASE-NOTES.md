# Mavio v0.0.1 — M0 discovery and contracts

M0 establishes the approved design baseline for `@vormir/mavio`, with bounded native/browser engine feasibility evidence. It is a specification milestone, not an installable SDK release.

## Delivered

- Product scope: vanilla JavaScript, TypeScript, Node and browser first; seven media operations; framework adapters and cloud deferred.
- Immutable pipelines, explicit engine ownership, capabilities, structured errors, progress, cancellation and disposal contracts.
- Six versioned presets with explicit format/encoder mappings: balanced/small video, MP3 audio, PCM audio, JPEG and PNG thumbnails.
- Native FFmpeg/FFprobe discovery, explicit browser assets, initialization deadlines and failure/retry rules.
- An explicit publication commit gate and post-publication cleanup warnings.
- Thirty-two resolved API edge-case scenarios with implementation-stage test ownership.
- Reproducible isolated experiments, exact dependency lockfile, raw evidence and initial failure records.

## Validation

- Native FFmpeg and Chrome/WASM read consistent normalized metadata and produced decodable 2.5-second trims containing the intended 60 video frames.
- All six presets encoded on both engines and their outputs decoded successfully; video output dimensions/frame rate were checked. Small video used about 28% fewer bytes than balanced on the synthetic fixture, with lower measured quality.
- Bounded native/browser cancellation, cleanup/reuse and initialization failure/retry checks passed.
- Strict TypeScript checks cover Node and browser consumers, output inference, preset IDs, initialization options, commit gating and cleanup-warning types.

These are experiments against native FFmpeg 6.1.1 / FFprobe 4.0.2 on Windows with Node 22.22.2, and Chrome 153 with @ffmpeg/ffmpeg 0.12.15 / @ffmpeg/core 0.12.10. They do not certify other versions/platforms or production adapter behavior. See the linked reports for precise measurements and limitations.

## Known limitations and implementation obligations

- The pinned browser core returns -1 for some successful metadata probes. A narrow fresh-JSON/schema/error validation workaround was tested; production integration must regression-test it or select a verified fixed build.
- Raw browser progress is unsuitable for direct job-level reporting during trims.
- Audio packet padding can change container duration; sample-accurate behavior remains to be tested.
- WebM has no built-in v1 preset. HDR/alpha/high-bit-depth handling, variable frame rates, large files, broader codecs and other runtime targets remain unverified.
- Native FFmpeg/FFprobe version-pair compatibility, no-clobber filesystem publication, queue races and memory/resource hardening require production conformance tests.
- There is no SDK implementation, repository-level build/CI workspace, npm publication or hosted documentation site in this milestone. The standalone feasibility package is private tooling.

## Next milestone

M1 (`v0.0.2`) establishes the monorepo, publishable SDK package layout, TypeScript build, runtime exports, tests, CI and contribution conventions. M2 implements the core against a mock engine; M3/M4 implement the native/browser adapters; M5 completes operation conformance.

## Baseline maintenance

Future owner suggestions are assessed for feasibility and compatibility, then reflected in contracts, implementation, examples and tests together. A published preset's policy change uses a new versioned ID. This release does not freeze all development APIs through v0.1.

## Evidence index

- [Scope](./scope.md)
- [Public API](./api.md) and [types](./contracts.ts)
- [Presets](./presets.md)
- [Initialization](./initialization.md)
- [Edge cases](./edge-cases.md)
- [Metadata/trim report](./feasibility/REPORT.md)
- [Acceptance record](./acceptance.md)
