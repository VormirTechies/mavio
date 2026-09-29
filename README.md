# Mavio

A JavaScript multimedia SDK for browser and Node.js runtimes.

## Status

**v0.0.3 — M2 core implementation.**

The core supports immutable pipelines, validation, serialized jobs, cancellation, progress, disposal, and execution through explicitly supplied engine adapters. The runtime suite contains 161 tests, including two integrated mock-adapter acceptance flows.

Native FFmpeg and browser ffmpeg.wasm adapters are not implemented yet. Omitting the engine or selecting `engine: "auto"` currently throws `ENGINE_UNAVAILABLE`. The SDK remains private and unpublished.

Mock-adapter tests verify core orchestration. They do not establish real-media encoding accuracy, filesystem publication safety, or production browser compatibility.

## Workspace

- `packages/mavio`: SDK, contracts, core implementation, and tests.
- `apps/docs`: documentation application placeholder.
- `apps/playground`: playground application placeholder.
- `testing/fixtures`: fixture conventions.

## Verification

Run `npm run check` from the repository root.

The check covers linting, formatting, compilation, consumer types, runtime tests, package installation, browser bundling, and a Chromium smoke test using a mock adapter.

CI is configured for Ubuntu and Windows with Node.js 22 and 24.

## Documentation

- [Approved M0 baseline](docs/m0/README.md)
- [API contract](docs/m0/api.md)
- [Preset definitions](docs/m0/presets.md)
- [Engine initialization contract](docs/m0/initialization.md)
- [Edge-case decisions](docs/m0/edge-cases.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

The M0 documents preserve the approved design and historical feasibility evidence. Their examples include behavior assigned to later milestones.

## Next milestones

- M3: native FFmpeg/FFprobe adapter, metadata, and one trim path.
- M4: browser adapter, worker/assets integration, metadata, and one trim path.
- M5: complete real-media operation coverage and shared conformance tests.

## License

[MIT](LICENSE)
