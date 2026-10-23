# M6 resource investigation

Status: Native and Browser investigations passed locally. Full repository checks
and fresh CI evidence remain part of final M6 acceptance.

## Scope

These checks exercise repeated jobs, rejected media, cancellation, recovery,
client disposal, and retained output ownership using a controlled three-second
320 × 240 fixture.

Each runtime completed 25 exports, five invalid-media attempts, five cancellation
attempts, five metadata recoveries, and five fresh-client cycles. All 25 outputs
per runtime were independently probed and decoded after client disposal. Caller
source content remained unchanged.

These are bounded observations, not a memory ceiling or a leak-free guarantee.

## Native findings

Raw evidence: [Native resource report](resources/m6-native-local-2026-10-24.json).

The calibrated process-wrapper observer recorded 233 SDK process wrappers, with
a peak of two. Every recorded checkpoint had zero active tracked process wrappers
and zero entries in the dedicated SDK temporary directory.

After forced garbage collection, RSS rose from approximately 53.57 MiB after
warmup to 59.78 MiB after releasing retained output references. JavaScript heap
rose from approximately 7.31 MiB to 8.05 MiB. This short sample does not establish
whether memory would stabilize over a longer workload.

Cancellation was triggered before engine execution. It does not establish active
encoding interruption latency.

Malformed input rejected with `EXECUTION_FAILED`, reason `NONZERO_EXIT`, and tool
`ffprobe`, matching the inspected Native probe mapping. The investigation did not
change that mapping.

### Read and cleanup race

The investigation identified an internal Native workspace cleanup race:
disposal waited for pending reads only when an input write was still pending.
A completed write could therefore allow removal while an output read remained
unsettled.

Two deterministic regression cases covered resolving and rejecting reads. Both
failed before the correction. Cleanup now waits for outstanding reads independently
of the input write state. The focused workspace, publication, and failure
precedence checks subsequently passed: 30 tests, zero failures.

This demonstrates the helper-level race and its correction; it does not establish
that ordinary public calls reproduced the race.

## Browser findings

Raw evidence: [Browser resource report](resources/m6-browser-local-2026-10-24.json).

All checkpoints had zero workspace directories and entries. After disposal and
fresh-client cycles, the observer recorded zero active workers.

Workspace accounting reconciled:

| Outcome                                         | Count |
| ----------------------------------------------- | ----: |
| Created workspaces                              |    66 |
| Explicitly deleted workspaces                   |    61 |
| Workspaces destroyed through worker termination |     5 |

WASM linear-memory capacity was 32 MiB at each checkpoint with an active worker.
After disposal, no observed active worker remained from which to measure capacity.

Page JavaScript heap after forced garbage collection rose from approximately
1.07 MiB after warmup to 1.54 MiB after releasing retained output references.
The run intentionally retained 25 output byte arrays totaling 3,632,625 bytes
until after disposal. Releasing those references did not immediately reduce the
reported page heap.

Cancellation followed dispatch of an `EXEC` message. This establishes dispatch
and subsequent cancellation/recovery, not that encoding had reported progress.
The separate Browser active-cancellation acceptance check supplies that evidence.

### Instrumentation boundaries

The investigation loaded the installed SDK and the pinned corrected engine assets.
A separately named test worker added a read-only snapshot message for workspace
enumeration and WASM capacity. The original worker file remained unchanged.
The report records hashes of both worker sources and SDK archive integrity.

Worker tracking observes creation and calls to `terminate()`. Filesystem tracking
observes acknowledged directory operations; snapshots independently enumerate
actual workspace directories and their entries between jobs.

CDP heap observations cover the page isolate. They exclude worker JavaScript
heaps and total Browser process RSS. WASM capacity is not a measurement of live
allocations. Zero observed active workers is not a total process-memory measurement.

## Reproduction

Run the Native resource script through its registered npm command with absolute
FFmpeg, FFprobe, and fixture paths:

```text
npm run check:resources:native -- <ffmpeg> <ffprobe> <fixture>
First prepare fresh installed-package examples using npm run check:examples.
Then run the Browser resource driver against its prepared vanilla-ts directory:
node scripts/check-browser-resources.mjs <consumer> <ffmpeg> <ffprobe> <fixture>

The Browser consumer directory is printed by the example verifier. Use a fresh
consumer when validating SDK changes: an existing consumer retains its previously
installed archive.
The fixture must satisfy the supported source profile. Setup, instrumentation,
forced collection, and independent decoding make these resource investigations
unsuitable as performance benchmarks.
Acceptance boundaries
The local runs demonstrate cleanup and output ownership for the exercised paths.
They do not establish universal media support, a production memory budget,
long-duration stability, total operating-system resource reclamation, or
cross-platform behavior for these new investigation scripts.
Final M6 acceptance still requires the documentation audit, full repository
checks, and appropriate fresh CI evidence.
```
