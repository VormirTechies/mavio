# Mavio

A universal JavaScript multimedia SDK with a simple API across browser and Node.js runtimes.

## Status

**M0 / v0.0.1: discovery and contracts complete.** The approved design and bounded engine experiments are recorded in [the M0 release notes](docs/m0/RELEASE-NOTES.md). This is a specification milestone; the SDK is not implemented or published to npm yet.

The planned package is `@vormir/mavio`. Its core describes media intent while pluggable engines perform execution. The initial engines are native FFmpeg for Node and ffmpeg.wasm for browsers. Framework adapters follow v0.1 core stability.

## Documentation

- [M0 overview](docs/m0/README.md)
- [Public API and contracts](docs/m0/api.md)
- [Preset definitions](docs/m0/presets.md)
- [Engine initialization](docs/m0/initialization.md)
- [Edge-case decisions](docs/m0/edge-cases.md)
- [Changelog](CHANGELOG.md)

## Next

M1 / v0.0.2 establishes the SDK/docs/playground monorepo, build, tests and CI. Implementation and broader compatibility verification follow the [milestone plan](docs/m0/README.md).

## License

[MIT](LICENSE)
