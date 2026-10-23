# Limits and troubleshooting

This guide covers the current supported Native and Browser routes.
Capability inventory does not guarantee that every readable file can complete
every transformation. Source profiles, selected streams, presets, and the
processing plan must also be supported.

## Runtime setup

### Node

Use `@vormir/mavio/node`. Install FFmpeg and FFprobe separately and make both
available on PATH, or configure their absolute executable paths through
`native.ffmpegPath` and `native.ffprobePath`.

Check that both tools execute successfully under the application's account.
A file existing at the configured location does not establish that it is
executable or compatible.

Input paths must resolve to regular files. Path output requires an existing
parent directory and an unoccupied destination. Do not delete an existing
destination automatically when handling `OUTPUT_EXISTS`.

### Browser

Use `@vormir/mavio/browser` with application-hosted, same-origin assets.
Generate the accepted corrected assets with the CLI shipped in the SDK.
Copying the unmodified upstream core is not the accepted configuration.

Follow [Browser engine assets](browser-engine-assets.md) for pinned versions,
generation, and URL configuration. The generation destination must be new;
generate into a new versioned directory when updating deployed assets.

Check the actual network responses for the core JavaScript, WASM, wrapper
worker, and wrapper dependencies. A successful HTML fallback response is not
a valid JavaScript or WASM response. Verify MIME types, same-origin URLs,
deployment headers, and the application's worker and script CSP.

The [consumer examples](../examples/README.md) include a local server with
the accepted COOP/COEP headers and JavaScript/WASM content types.
The example server is intended for local development.

Browser path input and path output are unsupported. Use bytes or Blob targets
according to the runtime capability inventory.

## Queue capacity and application concurrency

One client serializes its jobs. `maxQueuedJobs` defaults to 16 and counts
waiting jobs, excluding the active job.

| Setting or event           | Behavior                                                                          |
| -------------------------- | --------------------------------------------------------------------------------- |
| `maxQueuedJobs: 0`         | Allows an idle client to start a job; rejects additional submissions while active |
| Waiting capacity exhausted | Rejects the new submission with `QUEUE_FULL`                                      |
| Already-aborted signal     | Rejects with `CANCELLED` before queue-capacity admission                          |
| Cancellation while waiting | Removes the waiting job without starting engine work                              |
| Cancellation while active  | Keeps the active slot occupied until work and required cleanup settle             |

Do not use unbounded `Promise.all` submissions as a throughput strategy.
Await jobs or maintain a bounded application queue. Retry `QUEUE_FULL` after
capacity becomes available; avoid immediate retry loops.

Separate clients have separate queues and engine resources. Creating more
clients can increase simultaneous workers, subprocesses, staging, and memory.
The SDK does not provide a global resource scheduler across clients.

## Initialization deadline

`initTimeoutMs` defaults to 30000. It must be a positive finite integer.
It covers one initialization attempt, including capability discovery.

It is not a total media-job timeout and does not include time spent waiting
in the client queue. Increasing it cannot repair missing binaries, invalid
assets, unsupported builds, or deployment errors.

Timeout failures use `ENGINE_INIT_FAILED` with `details.reason` equal to
`TIMEOUT`. Caller cancellation uses `CANCELLED`. Primary failure precedence
and required cleanup can affect when the returned promise settles.

The default adapters observe cancellation. An injected adapter must implement
the signal and lifecycle contract; a deadline is not an operating-system
preemption mechanism for arbitrary adapter code.

## Media and preset restrictions

Use [conversion profiles](m5-conversion.md), [presets](m5-presets.md), and the
operation-specific M5 guides when choosing source media and transformations.

The accepted MP4 examples use square-pixel SDR video with explicit bt709
primaries, transfer, and color space, tv range, and yuv420p pixels. Supported
audio and Browser geometry/orientation restrictions also apply.

A familiar filename extension, available decoder, or successful metadata probe
does not establish full transformation support. Do not relabel unsupported
media or infer missing color information merely to bypass validation.

Unsupported and unknown plan support both reject before encoding.
Inspect `UNSUPPORTED_PLAN` or `UNKNOWN_SUPPORT` reasons and compare the source
and plan with the documented profiles.

Compression is not a guarantee of smaller output for arbitrary media.
Quality and size observations from controlled fixtures apply to those fixtures.

## Memory and resource limits

There is no universal supported maximum file size established by these checks.
Optional capability limits are engine declarations; an omitted limit is
unspecified, not unlimited.

Compressed input size alone does not predict peak memory. Decoded frames,
audio samples, intermediate files, output buffers, caller-retained outputs,
and concurrent clients all contribute.

Browser processing uses worker memory and a WASM linear-memory allocation.
Page JavaScript heap measurements do not include all worker or process memory.
Native Node memory observations do not include all FFmpeg/FFprobe child memory.

Prefer a bounded workload, avoid retaining unnecessary input/output copies,
revoke application-created object URLs when no longer needed, and await client
disposal when finished. Successful output bytes remain usable after disposal.

See [resource investigation](m6-resources.md) and
[performance baseline](m6-performance.md) for measured scope and raw evidence.
Neither establishes a production memory budget or universal performance limit.

## Errors and recovery

| Error or outcome           | Next action                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `ENGINE_UNAVAILABLE`       | Check tool installation, configuration, and any unsafe-session reason                   |
| `ENGINE_INIT_FAILED`       | Check runtime setup; inspect a timeout reason before adjusting the deadline             |
| `INVALID_INPUT`            | Check input shape, nonempty bytes, file availability, and runtime input support         |
| `INVALID_OPTIONS`          | Correct the operation options, selected stream, or logical time interval                |
| `INVALID_MEDIA`            | Check media validity and the documented source requirements                             |
| `UNSUPPORTED_CAPABILITY`   | Compare the plan, preset, input/output kinds, and source profile with supported routes  |
| `OUTPUT_EXISTS`            | Choose a new destination or let the application explicitly manage the existing file     |
| `IO_ERROR`                 | Check access, parent directories, available storage, and staging/publication conditions |
| `RESOURCE_LIMIT`           | Reduce the workload and inspect applicable engine limits                                |
| `CANCELLED`                | Await settlement before recovery; cancellation may require engine cleanup and reload    |
| `DISPOSED`                 | Create a fresh client; disposal is permanent                                            |
| Cleanup warning on success | Preserve the successful output and report the remaining cleanup issue separately        |

Native malformed-media probing can reject with `EXECUTION_FAILED`, reason
`NONZERO_EXIT`, and tool `ffprobe`. Do not classify every `EXECUTION_FAILED`
as malformed media: it also represents other execution failures.

When cleanup succeeds, supported failure paths can lazily reload the engine
on the next job using the same client. If cleanup leaves the session unsafe,
subsequent jobs reject with `ENGINE_UNAVAILABLE` and reason `UNSAFE_ENGINE_STATE`.
Do not repeatedly reuse that session. Retain cleanup diagnostics and handle
the underlying resource problem before starting new work.

`dispose()` cancels queued work and requests cancellation of active work.
Its promise waits for queue drainage and engine disposal. Repeated calls share
the disposal result. Cleanup failure does not reopen the client.

Cancellation after the publication gate can still yield a successful result.
Use the terminal method result or rejection as the authoritative outcome.
Post-publication cleanup warnings do not invalidate a successful output.

## Progress and diagnostics

Progress percentages can be absent; only completion establishes 100 percent.
Do not treat missing percentages as a stalled engine or diagnostic callbacks
as a publication-control mechanism.

Keep observers short. Their synchronous CPU work still consumes the event loop.
Use [opt-in diagnostics](m6-diagnostics.md) for the event contract and field
boundaries. Diagnostic events do not automatically log or upload information.

Error causes and other diagnostic fields can contain sensitive information.
Applications should review their own logging before recording paths, URLs,
raw causes, or media-related details.

## Verification boundaries

The reviewed queue, initialization, error, and lifecycle behavior is covered by
the focused checks recorded in [M6 acceptance](m6-acceptance-matrix.md).
The consumer examples and resource investigations supply separate local
real-engine evidence.

This guide does not extend accepted media profiles or establish cross-platform
acceptance for unverified changes. Final M6 checks and fresh CI remain required.
