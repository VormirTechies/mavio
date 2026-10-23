# Mavio

A JavaScript multimedia SDK for browser and Node.js runtimes.

## Status

**v0.0.3 — private and unpublished.**

Implemented components include core orchestration, a native FFmpeg/FFprobe
adapter, and a browser ffmpeg.wasm adapter.

The public API supports metadata, conversion, trimming, resizing, audio
extraction, thumbnails, and preset-based compression within documented profiles.

M5 acceptance and documentation work is in progress. Local acceptance covers
tested scenarios. Fresh cross-platform CI evidence remains outstanding.

## Workspace

- `packages/mavio`: SDK, contracts, adapters, and tests.
- `apps/docs`: documentation application placeholder.
- `apps/playground`: playground application placeholder.
- `testing/fixtures`: fixture conventions.

## Getting started

Use `@vormir/mavio/node` for Node and `@vormir/mavio/browser` for browsers.
The root entry selects the implementation through package export conditions.

Node requires separately installed FFmpeg and FFprobe. Mavio discovers them
on the captured PATH or accepts explicit absolute binary paths.

Browsers require application-hosted generated engine assets.
See the [package README](packages/mavio/README.md) for setup.

Initialization is lazy. Always await `client.dispose()` after use.

## Verification

Run from the repository root:

```sh
npm run check
npm run check:native:all
npm run check:browser:verified
```

Real native and installed-package Browser acceptance are separate from
the main static, unit, type, and package-consumer checks.
Native acceptance requires FFmpeg and FFprobe.

Passing mock-adapter tests does not establish real-engine behavior.
See the [M5 acceptance matrix](docs/m5-acceptance-matrix.md) for evidence,
tested profiles, and outstanding verification.

## Documentation

- [Package setup](packages/mavio/README.md)
- [M5 acceptance matrix](docs/m5-acceptance-matrix.md)
- [Approved M0 baseline](docs/m0/README.md)
- [Historical API contract](docs/m0/api.md)
- [Preset definitions](docs/m0/presets.md)
- [Historical initialization contract](docs/m0/initialization.md)
- [Edge-case decisions](docs/m0/edge-cases.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

M0 documents preserve the approved design and historical feasibility evidence.
Current default entry points reject configuration for the other runtime;
do not supply both `native` and `browser` options.

## Remaining milestone work

- M4: close outstanding release gates, including fresh cross-platform CI evidence.
- M5: finish recipe verification and consolidate acceptance evidence.

[Public API recipes](docs/m5-recipes.md)

## License

[MIT](LICENSE)
