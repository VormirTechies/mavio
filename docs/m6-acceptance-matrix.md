# M6 developer experience and hardening

## Status

Baseline inventory recorded on 2026-10-23.
M6 is complete within the bounded acceptance scope recorded below.

Baseline commit: 4dc8a84971991efbc76b29870e31047052bbf170.
The project owner reported successful CI run 39981807858 for that commit.

M4 and bounded M5 acceptance are complete.
Their passing checks provide reusable evidence, not automatic M6 completion.

## Baseline findings

- Public contracts expose typed inputs, output inference, capabilities,
  structured errors, progress, cancellation, queue capacity, and disposal.
- Consumer type checks cover Browser and Node module-resolution configurations.
- Existing consumer tests include positive output inference and selected
  invalid-option checks.
- Error construction preserves causes and independent frozen diagnostic
  snapshots in the inspected tests.
- Failure-precedence, engine-session, initialization, workspace, publication,
  and cancellation test files exist. Their presence is an inventory finding;
  task-specific behavioral coverage still needs review.
- No public debug option appears in MavioOptions.
- The SDK source search found internal diagnostic handling but no console
  logging references. This is not a complete privacy audit.
- No tracked examples directory or dedicated benchmark files appeared in
  the initial inventory.
- Measurement API matches appeared in core initialization, core progress,
  and the Browser cancellation smoke. Their purpose remains to be inspected.
- Docs and playground applications remain placeholders.

## Task matrix

| ID    | Task                       | Baseline                                                                       | Required exit evidence                                                                                                           | Status                                     |
| ----- | -------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| M6-01 | Baseline inventory         | Contracts, consumer checks, error construction, and relevant files inventoried | Traceable inventory distinguishing implemented behavior from unverified requirements                                             | Inventory complete                         |
| M6-02 | Types and capabilities     | Contracts and consumer checks exist                                            | Review public consumer routes, output inference, capability discovery, and unsupported/unknown handling; close demonstrated gaps | Complete locally                           |
| M6-03 | Actionable errors          | Structured codes and preserved diagnostics exist                               | Review setup, source-profile, plan, cancellation, disposal, and cleanup errors for stable codes and useful remediation           | Complete locally for reviewed cases        |
| M6-04 | Safe opt-in diagnostics    | No public debug option identified                                              | Define required diagnostic scope; verify useful sanitized events, disabled behavior, and observer isolation                      | Complete locally                           |
| M6-05 | Runnable consumer examples | M5 documentation recipes verified; tracked example projects not identified     | Reproducible Vanilla JS, TypeScript, and Node consumers using the packaged SDK                                                   | Complete locally                           |
| M6-06 | Performance baseline       | No dedicated benchmark identified                                              | Reproducible initialization and warm-operation measurements with environment and fixture provenance                              | Complete locally for recorded baseline     |
| M6-07 | Resource lifecycle         | Existing lifecycle and cleanup suites                                          | Repeated-job, rejection, cancellation/recovery, and client-disposal evidence; investigate sustained resource growth              | Complete locally for bounded investigation |
| M6-08 | Limits and troubleshooting | Existing runtime and source-profile documents                                  | Evidence-based setup, memory, queue, timeout, source restriction, and recovery guidance                                          | Complete locally for reviewed guidance     |
| M6-09 | Final acceptance           | M4/M5 CI evidence reusable                                                     | Consolidated M6 evidence, appropriate regression checks, and fresh CI for final changes                                          | Complete                                   |

## Measurement rules

- Timing APIs used for deadlines or progress do not establish benchmarks.
- JavaScript heap measurements alone do not establish total Browser or WASM
  memory usage.
- Node process memory alone does not include all native child-process memory.
- Record runtime, engine, hardware, fixture, repetitions, and measurement method.
- Separate cold initialization from warm processing.
- Do not invent a universal maximum input file size.
- Test observations do not become performance guarantees.
- Do not require garbage-collected memory to return immediately to an exact
  starting value; investigate sustained growth with appropriate measurements.
- Inspect existing helpers before creating duplicate fixture generators.

## Scope boundaries

M6 hardens existing supported operations.
New formats, framework adapters, cloud services, and public publication
are outside this milestone.

Final release security/license review and RC publication remain M7 work.
Address critical findings discovered during M6 before closing the milestone.

## Completion rule

Close each task using recorded evidence or a justified scope decision.
Do not infer completion from file presence or earlier unrelated tests.
M6 closes only after its acceptance record and required checks are complete.

## M6-02 local verification — 2026-10-23

Reviewed public contracts, consumer type configurations, capability client,
preflight, execution, and relevant capability/adapter-response tests.

Added compile-only consumer checks for:

- JPEG byte output and PNG Blob output inference.
- Rejection of incorrect output-property access.
- Readonly capability operation and encoding arrays.
- Capability preset and optional input-limit types.
- Readonly progress events and optional percentage values.

Verification:

- Browser and Node consumer type checks passed.
- SDK build passed.
- All 49 focused tests passed, with no failures, skips, or cancellations.
- Focused suites: capability-client, browser-capabilities, preflight,
  execution-client, and adapter-response.

Existing behavior rejects unsupported and unknown plans before encoding,
using UNSUPPORTED_PLAN and UNKNOWN_SUPPORT reason codes respectively.
Existing tests cover capability initialization, independent results,
cancellation, timeout, cleanup, and retry.

No production runtime change was required for this task.
Consumer additions are compiled, not executed as media-processing examples.
Injected-adapter tests do not independently establish real-engine execution;
the existing M4/M5 evidence remains separate.

This task does not establish completion of the actionable-error or safe
diagnostics reviews. Final formatting and milestone-wide CI remain pending.

## M6-03 local verification — 2026-10-23

Reviewed native discovery, Browser worker initialization, plan preflight,
execution support rejection, error construction, and failure precedence.

Changes:

- Browser initialization failures now suggest checking generated same-origin
  JS/WASM assets, worker dependencies, HTTP responses, deployment headers,
  CSP, and the initialization deadline.
- Unsupported or unknown plans now suggest checking source profiles,
  requested operations, capabilities, and documented presets.
- Error codes, support reason codes, cause retention, and cleanup handling
  were not changed.

Verification:

- SDK build passed.
- All 40 focused tests passed without failures, skips, or cancellations.
- Suites: errors, browser-initialize, native-discovery, execution-client,
  and failure-precedence.
- Three added regression checks verify actionable guidance, preserved
  support reasons, rejection before execute, and exclusion of sensitive
  cause or adapter text from the new messages.
- Formatting and targeted ESLint checks passed.
- Existing preflight behavior was also reviewed and exercised under M6-02.

Native missing-binary guidance already explains installation and explicit
binary-path or PATH configuration. Existing tests cover primary-error
preservation through cancellation, disposal, and cleanup failures.

This is bounded evidence for the reviewed cases, not an exhaustive audit of
every error message. Causes remain available to callers and can contain
sensitive information; the new message checks do not establish complete
diagnostic privacy. M6-04 owns the broader diagnostic design and review.

Milestone-wide regression checks and fresh CI remain pending.

## M6-03 public initialization guidance follow-up

Further inspection found that EngineSession replaced initialization messages
with generic text before the public client received them.

The session now supplies fixed, actionable guidance for:

- Missing engine setup, including default Node FFmpeg/FFprobe installation.
- Native initialization failures, including paths, permissions, and compatibility.
- Browser initialization failures, including generated assets and deployment setup.
- Initialization timeouts, including the initTimeoutMs setting.

The wrapper does not copy original cause messages into this guidance.
Causes remain available separately for caller-controlled debugging.

Four added checks exercise the public Node and Browser factories.
They verify codes, preparing stage, admitted job IDs, applicable guidance,
cause retention, timeout reasons, and exclusion of a sensitive test marker
from the public message.

Verification:

- SDK build passed.
- All 48 focused tests passed, without failures, skips, or cancellations.
- Suites: capability-client, engine-session, browser-initialize,
  native-discovery, and failure-precedence.
- Test syntax, formatting, and targeted ESLint checks passed.

This supplements the earlier 40-test run; the suites overlap and their
counts must not be added together as a distinct-test total.
Milestone-wide regression checks and fresh CI remain pending.

## M6-04 local verification — 2026-10-23

Added an optional onDiagnostic callback and exported DiagnosticEvent type.
The reporter emits asynchronous, frozen job-progress and job-error snapshots.
It copies only approved fields and does not automatically log or upload events.

The callback reference is captured at client creation. Observer throws and
rejected promises are isolated; observer promises are not awaited.
Existing onProgress delivery remains intact.

Verification:

- SDK build passed.
- Browser and Node consumer type checks passed.
- Eleven diagnostics tests passed.
- The combined diagnostics, progress, capability-client, and failure-precedence
  run passed all 37 tests without failures, skips, or cancellations.
- Tests cover asynchronous snapshots, field restrictions, disabled behavior,
  invalid options, observer capture, safe errors, observer failures,
  pre-aborted requests, and observer-triggered cancellation/disposal.
- Formatting and targeted ESLint checks passed.
- The new runtime test file is registered in the normal package test command.

See [diagnostics documentation](m6-diagnostics.md) for usage and limitations.

Custom adapter identifiers remain caller-controlled. Original error causes
remain separate and can contain sensitive information. Synchronous observer
work consumes the event loop despite asynchronous delivery.
These checks do not establish a complete privacy audit or real-media execution.

Full repository/package regression checks and fresh CI remain pending.

## M6-05 installed-consumer verification — 2026-10-24

Added standalone Node, Vanilla JS, and strict TypeScript consumer examples.
Browser examples share a localhost static server with the accepted deployment
headers and JavaScript/WASM content types.

The check:examples command builds and packs the SDK, installs it into fresh
temporary example copies, and verifies installed entry-point resolution.
It leaves source example manifests and assets unchanged.

The combined verifier passed locally:

- All three consumers installed the SDK archive.
- Both Browser asset generators and bundles passed.
- The TypeScript example passed its own strict consumer type check.
- The Node example produced an independently probed and decoded H.264/AAC MP4.
- Both Browser examples handled invalid media and deterministic immediate
  UI cancellation, then completed a subsequent valid conversion.
- Browser downloads occurred after client disposal.
- Worker tracking returned to zero active workers.
- Output codec, expected resize geometry, audio presence, and complete
  independent decoding passed.
- Normal repository lint passed with example source coverage enabled.

The Node example retains an operation error if disposal also fails and
reports success only after successful disposal. The real-engine success path
was exercised; simultaneous operation/disposal failure was not newly injected
into this example.

Environment: Windows x64, Node v24.22.1, Chromium 153.0.8010.12,
FFmpeg/FFprobe 9.0.2 essentials. The fixture was the previously verified
three-second 320x240, 24 fps, square-pixel H.264/AAC SDR source with explicit
bt709 color metadata and 48000 Hz mono audio.

See [runnable consumer examples](../examples/README.md).

Immediate UI cancellation is distinct from active encoding cancellation;
the existing M4/M5 active-encoding evidence remains separate.
Other platforms and milestone-wide fresh CI remain pending.

## M6-06 local performance baseline — 2026-10-24

Native and installed-package Browser benchmarks completed on the same local
hardware, SDK archive, and source fixture.

Both recorded three fresh-client capability requests, five warm capability
requests, five warm metadata requests, and three warm-client MP4 byte exports.
All six exports independently probed and decoded after disposal.
Source preservation passed; the Browser run ended with zero tracked workers.

Raw reports and measurement methodology are preserved in
[the performance guide](m6-performance.md). Benchmark scripts passed formatting
and repository lint. The measurements have no speed acceptance threshold and
do not establish memory safety, universal throughput, or other-platform results.

Resource investigation remains M6-07; milestone-wide fresh CI remains pending.

## M6-07 local resource investigation — 2026-10-24

Native and installed-package Browser resource investigations passed locally.
Each exercised 25 exports, five invalid-media attempts, five cancellations,
five metadata recoveries, and five fresh-client cycles. All 25 outputs per
runtime were independently probed and decoded after disposal. Source content
and retained output hashes remained unchanged.

Native observations:

- The calibrated observer recorded 233 SDK process wrappers, with a peak of two.
- Every checkpoint had zero active tracked process wrappers and zero entries
  in the dedicated SDK temporary directory.
- After collection, RSS changed from approximately 53.57 to 59.78 MiB and
  JavaScript heap from 7.31 to 8.05 MiB across the recorded investigation.
- Cancellation was triggered before engine execution.
- Malformed input matched the inspected Native probe rejection:
  EXECUTION_FAILED, NONZERO_EXIT, tool ffprobe.

Browser observations:

- Every checkpoint had zero remaining workspace directories and entries.
- Final active worker count was zero.
- All 66 workspace creations reconciled with 61 explicit deletions and five
  workspaces destroyed through worker termination.
- Active-worker WASM capacity remained 32 MiB at the measured checkpoints.
- Page heap after collection changed from approximately 1.07 to 1.54 MiB.
- Cancellation followed EXEC dispatch; this does not establish encoding progress.
- A separate test worker provided read-only snapshots. Original assets remained
  unchanged; source hashes and archive provenance are recorded.

The investigation also corrected an internal Native workspace race. Two
deterministic regression cases failed before the correction because removal
could start while a read remained pending after input staging had finished.
Cleanup now waits for pending reads independently of pending writes.
The focused workspace, publication, and failure-precedence run passed all
30 tests after the correction.

Fresh installed-package examples passed after the Native correction.
Browser resource scripts passed formatting and targeted lint.

See [resource investigation](m6-resources.md) for raw report links, reproduction,
instrumentation boundaries, memory observations, and regression evidence.

This closes the bounded local investigation. It does not establish long-duration
memory stability, total Browser or child-process memory budgets, universal media
support, or cross-platform execution of the new resource scripts.
M6-08 guidance and M6-09 final checks and fresh CI remain pending.

## M6-08 local guidance review — 2026-10-24

Reviewed the serial queue implementation, initialization deadline behavior,
session recovery, diagnostic contract, Browser asset guidance, consumer examples,
and the recorded performance and resource investigations.

Added [limits and troubleshooting](m6-troubleshooting.md), covering:

- Native tool installation and Browser generated-asset deployment.
- One active job per client and the default capacity of 16 waiting jobs.
- Queue overflow, waiting cancellation, active cleanup, and bounded submissions.
- Initialization deadlines distinguished from queue time and job timeouts.
- Source-profile and preset restrictions without expanding accepted media support.
- Memory measurement boundaries without inventing a universal maximum file size.
- Error-specific remediation, unsafe-session handling, and permanent disposal.
- Publication-gate cancellation behavior and successful-output cleanup warnings.
- Progress, observer overhead, and application-controlled diagnostic logging.

The guide links to existing source-profile and asset instructions rather than
introducing a duplicate fixture generator.

Verification:

- Guide formatting passed.
- All 18 local link targets across the inspected M6 guides and example READMEs
  existed; the audit completed with a successful process exit.
- Diff whitespace checks passed.
- Runtime claims refer to the focused and real-engine evidence recorded above.

The link audit does not validate headings, external URLs, or recipe execution.
This is bounded guidance review, not an exhaustive audit of every error path.
M6-09 full regression checks and fresh CI remain pending.

## M6-09 final local verification — 2026-10-24

The full npm run check command passed, including lint, repository formatting,
build, type checking, Browser and Node consumer type checks, runtime tests,
and installed-package verification.

Results:

- 914 SDK runtime tests passed.
- Eight helper tests passed.
- No test failures, cancellations, skips, or todos were reported.
- Installed-package imports, Browser bundling, and Chromium runtime passed.
- Diff whitespace checks passed.

The combined check:m6 runner also passed locally using its generated and
independently validated three-second fixture:

- All three installed-package examples passed.
- Native and Browser resource investigations each decoded 25 outputs after disposal.
- Final tracked processes, workers, and workspace entries were zero.
- Source preservation and retained-output ownership checks passed.

CI now includes additional Ubuntu 24.04 jobs for Node 22 and Node 24 running
check:m6, alongside the existing cross-platform SDK and media-route jobs.

M6 remains pending fresh successful CI for the committed changes.
Local memory observations remain bounded and are not leak-free guarantees.

## M6 closure — 2026-10-24

M6 is accepted as complete within its documented scope.

Implementation commit: bd39f209188a85ca2dc5080dc8ffff977a0b3d79.

[Passing CI run 40019434190](https://github.com/VormirTechies/mavio/actions/runs/40019434190)
completed successfully. All 18 jobs completed with success:

- Four SDK verification jobs: Ubuntu and Windows, Node 22 and 24.
- Six Native media jobs: Ubuntu, Windows, and macOS, Node 22 and 24.
- Six installed-package Browser route jobs: Ubuntu, Windows, and macOS,
  Node 22 and 24.
- Two M6 examples and bounded resource jobs: Ubuntu 24.04, Node 22 and 24.

The new M6 runner also passed locally on Windows. Its additional resource and
example CI coverage is Ubuntu-specific; the existing cross-platform media jobs
do not establish execution of the new resource investigations on macOS.

Local full checks passed with 914 SDK tests, eight helper tests, consumer type
checks, lint, formatting, build, and installed-package verification.

Accepted deliverables include consumer typing, actionable error guidance,
opt-in structured diagnostics, three installed-package examples, reproducible
performance observations, bounded resource investigations, the Native workspace
read/cleanup correction, troubleshooting guidance, and consolidated evidence.

Earlier pending-CI statements above describe intermediate verification stages.
This closure records the subsequent passing implementation CI.

Performance observations remain local baselines without speed guarantees.
Resource observations do not establish a universal memory ceiling or leak-free
long-duration behavior. Supported media profiles remain bounded.

M7 security/license review and release-candidate preparation, and M8 publication,
remain separate milestones. M6 completion does not authorize package publication.
