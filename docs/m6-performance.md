# M6 performance baseline

Measured locally on 2026-10-24. These are observations, not speed guarantees
or acceptance thresholds.

## Environment and fixture

- CPU: AMD Ryzen 7 7730U with Radeon Graphics.
- Logical CPUs: 16.
- OS: win32/x64, release 10.0.26300.
- Node: v24.22.1.
- Chromium: 153.0.8010.12.
- Native tool provenance is recorded in the raw report.
- Browser wrapper/core: 0.12.15/0.12.10.
- The same installed SDK archive and source fixture were used for both runs.
- Fixture bytes: 137928.
- Fixture duration: 3 seconds.

Fixture SHA-256: 49e25d3d769b42b181e75ff94bebe4803e68ee18bb9ac0c0e5a0ef4ec533e815.

The fixture is the verified 320x240, 24 fps, square-pixel H.264/yuv420p
SDR source with explicit bt709 metadata and 48000 Hz mono AAC audio.

## Results

| Runtime | Phase                                | Runs | Minimum ms | Median ms | Maximum ms |
| ------- | ------------------------------------ | ---- | ---------- | --------- | ---------- |
| Native  | fresh-client capabilities            | 3    | 478.13     | 488.40    | 579.31     |
| Native  | warm-client capabilities             | 5    | 0.04       | 0.06      | 0.15       |
| Native  | warm-client metadata                 | 5    | 62.23      | 62.64     | 73.97      |
| Native  | warm-client balanced MP4 byte export | 3    | 387.70     | 410.74    | 489.75     |
| Browser | fresh-client capabilities            | 3    | 253.07     | 272.47    | 361.54     |
| Browser | warm-client capabilities             | 5    | 0.18       | 0.21      | 0.28       |
| Browser | warm-client metadata                 | 5    | 7.51       | 8.11      | 10.35      |
| Browser | warm-client balanced MP4 byte export | 3    | 784.56     | 812.20    | 904.89     |

## Measurement method

- Fresh-client capability timing covers the first capabilities request;
  client construction and disposal are outside that interval.
- Warm capability and metadata requests use an initialized client.
- Metadata is primed before its five recorded warm requests.
- Three balanced MP4 byte exports run sequentially on that same client.
- Native input is a filesystem path; Browser input is caller-owned bytes.
- Native warm exports still create new FFmpeg processes.
- Progress and diagnostics observers are disabled during these timings.
- File writing, Browser result transfer, and independent decoding occur
  outside the export timing interval.
- Fresh clients do not guarantee cold OS, browser, or compiled-WASM caches.
- Browser assets are served locally; deployment network latency differs.

Input preparation and engine builds differ across runtimes. This small
fixture does not establish a general performance ranking or throughput limit.

## Correctness checks

All six measured exports were independently probed and decoded after
client disposal. Source preservation checks passed in both runtimes.
The Browser run created four workers and ended with zero tracked active workers.

These runs do not measure memory or establish absence of leaks.
M6-07 owns resource-lifecycle investigation.

## Reproduce

First prepare current installed consumers using check:examples.
Use their printed temporary paths; building the workspace alone does not
refresh an already installed consumer.

```sh
npm run benchmark:native -- <installed-node-consumer> <ffmpeg> <ffprobe> <fixture>
npm run benchmark:browser -- <prepared-browser-consumer> <ffmpeg> <ffprobe> <fixture>
```

Use absolute paths. The Browser consumer must be vanilla-js or vanilla-ts
inside the prepared examples tree, with its shared server and generated assets.

Each run prints a report path. Reports include raw samples, environment,
fixture identity, SDK archive integrity, and verification results.

## Evidence

[Preserved raw reports](benchmarks/m6-local-baseline-2026-10-24.json)
contain both complete local reports, including the raw timing samples.

Benchmark formatting and repository lint passed.
Broader fixtures, other hardware, and milestone-wide CI remain separate work.
