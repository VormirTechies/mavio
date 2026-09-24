# Public API and behavioral contract

Status: API baseline approved by the project owner on 2026-09-25. Examples are specifications, not runnable SDK code.

## Client and pipeline

```ts
const client = createMavio({ engine: "auto", browser: { assets: { coreURL: "/media-engine/ffmpeg-core.js", wasmURL: "/media-engine/ffmpeg-core.wasm" } } });
const abort = new AbortController();
try {
  const pipeline = client.from({ kind: "blob", blob: file });
  const result = await pipeline
    .trim({ start: 5, end: 20 })
    .resize({ width: 1280, height: 720 })
    .compress({ preset: "video-balanced-v1" })
    .export(
      { format: "mp4", output: { kind: "blob" } },
      { signal: abort.signal, onProgress: event => console.log(event) },
    );
  // result.output is a Blob output selected by the output target.
} finally {
  await client.dispose();
}
```

Node uses the same transformations with `{ kind: "path", path: "input.mp4" }` and an explicit `{ kind: "path", path: "output.mp4" }` output target. Engine-specific entry points may be established in M1, but importing the browser entry must not load Node process/filesystem modules.

`createMavio` is synchronous and does no engine I/O. `capabilities()` or the first job initializes lazily. `from()` validates input shape and captures an input reference without reading media. Pipelines are immutable: each method returns a new plan. Execution starts at `export()`, `thumbnail()` or `metadata()`. Each call creates a fresh job; outputs are not implicitly cached.

One-shot usage uses the same client: `client.from(input).export(...)` or `.metadata()`. Separate convenience function families are deferred to avoid redundant contracts.

## Operation semantics

- Times are finite numbers in seconds; strings are excluded. Trim requires `0 <= start < end`. End beyond known source duration fails. If duration cannot be established, preparation fails with `INVALID_MEDIA`; do not silently clamp. Output timestamps start at zero. Boundaries are limited by frame/sample granularity, not a promise of sub-frame accuracy.
- Trim, resize and extractAudio see the preceding logical transformation's output. Convert and compress declare final encoding settings without intermediate lossy encoding. A second trim is relative to the first trim's timeline. Plans are validated before execution; implementations may fuse operations only if semantics remain equivalent.
- Resize requires positive integer width and height. It fits within the box, preserves display aspect ratio and accounts for source rotation. It never crops or upscales. Encoder dimension constraints may round down; actual dimensions are reported in result metadata.
- Convert sets output format and a compatible preset. Only one convert and one compress are allowed per plan. Their presets must agree when both appear; conflicting configuration is rejected, not resolved by last-write wins. Export format, if supplied, must agree with convert format. At least one explicit format is required.
- Compress selects encoding policy; it is not a transformation that promises fewer bytes. Other media transforms preserve stream intent and export uses the selected preset. Without a selected preset, export fails with `INVALID_OPTIONS`; no hidden format-dependent quality default.
- `extractAudio()` defaults to the first audio stream by source order; `streamIndex` selects an absolute source stream index. It is allowed at most once; resize and thumbnail after it are invalid. Unsupported stream selection fails during preflight.
- Export video preserves the first video stream and first audio stream when supported. Audio output uses the selected audio stream. Extra streams, subtitles, chapters and source tags are excluded in v0.1; orientation is normalized and output metadata reflects the result. Missing required streams fail clearly.
- `thumbnail({ at, format, preset, output })` is terminal, uses the transformed timeline, accepts JPEG/PNG output, and fails outside the known duration. A prior convert/compress is invalid for this terminal operation; its own format/preset controls image encoding. Blob, bytes and Node-path targets follow the common output rules.
- `metadata()` is terminal and allowed only on an untransformed source pipeline. It performs probing without exporting media. Unknown duration, bitrate or stream values remain absent, not zero. Results after transformation are available on export/thumbnail results.

## Jobs and progress

One client executes one job at a time, with additional jobs queued FIFO. Separate clients are independent. Queue size is bounded by `maxQueuedJobs` (default 16, excluding the running job); overflow returns `QUEUE_FULL`. Engines do not own scheduling.

Lifecycle: queued → preparing → running → finalizing → completed. A nonterminal job may fail; cancellation may terminate it only before its commit gate is granted. Metadata jobs use the same stages; stages with no substantial work may be brief. Every accepted job emits exactly one terminal event with a unique job ID. A rejected queue submission is not an accepted job.

Progress includes a stage and optional job-level percent from 0 through 100. Percent, when present, never decreases and reaches 100 only at successful completion. Unknown progress is represented by omission, not a fabricated timer. Adapter-specific percentages are translated by the core; event frequency is bounded. Subscriber exceptions do not cancel the processing job and are isolated from engine callbacks.

## Cancellation and disposal

An already-aborted signal rejects immediately. Queued cancellation removes the job without starting the engine. Running cancellation interrupts engine work and performs cleanup before the promise rejects with `CANCELLED`. The core grants or denies an explicit beginCommit gate before final publication. Cancellation recorded before the gate prevents publication; once the gate is granted, later cancellation waits for the publication result. Gate acquisition does not guarantee publication success. Failed/cancelled jobs never return a successful output.

`dispose()` rejects new work, cancels queued/running jobs and awaits cleanup. Repeated calls share the same outcome. Output objects previously returned remain usable. Following cancellation, a later job may reinitialize an engine; successful reuse must be tested. Cancellation latency is measured per engine, not promised to be instantaneous.

## Failure contract

All terminal methods reject with `MavioError` containing a stable code, message, stage, optional job/operation/engine identifiers and safe actionable details. Original causes may be retained for debugging but must not be logged automatically. Validation never starts encoding. Core returns `UNSUPPORTED_CAPABILITY` when the selected engine cannot perform the plan; there is no silent engine/network fallback.

Error codes: INVALID_INPUT, INVALID_OPTIONS, INVALID_MEDIA, UNSUPPORTED_RUNTIME, UNSUPPORTED_CAPABILITY, ENGINE_UNAVAILABLE, ENGINE_INIT_FAILED, EXECUTION_FAILED, OUTPUT_EXISTS, IO_ERROR, RESOURCE_LIMIT, QUEUE_FULL, CANCELLED, DISPOSED and CLEANUP_FAILED. Preserve the primary failure if cleanup also fails; attach cleanup issues as secondary diagnostics. After successful publication, cleanup failures become MediaResult.warnings rather than rejecting an already published result.


## Engine integration notes from feasibility (2026-09-25)

The public signatures remain unchanged. For the tested browser core 0.12.10, isolate the observed ffprobe -1 return-code quirk behind a version-specific fresh-output/schema/error validation shim, or choose a verified fixed build. Never treat all nonzero returns as success. Normalize progress from trustworthy planned-output timing instead of forwarding raw engine percentages; completion remains tied to publication. Running cancellation must stop engine execution, release job resources and allow reinitialization, as proved through worker termination/reload in the bounded experiment. See [the feasibility report](./feasibility/REPORT.md) for evidence and outstanding coverage.

Preset/format compatibility is defined in [the approved six-preset baseline](./presets.md). No implicit resizing, frame-rate change or encoder fallback is introduced by a preset.


Default native discovery, explicit browser assets, initialization deadlines and retry behavior are defined in [engine initialization](./initialization.md). The browser example requires the application to host the specified engine assets.


## Resolved edge cases

[Edge-case decisions](./edge-cases.md) defines validation precedence, terminal restrictions, stream errors, input ownership, frame boundaries, commit gating, cleanup warnings, progress frequency and disposal. Its E01-E32 scenario table is the normative acceptance reference; these are specification walkthroughs, not implemented SDK tests.
