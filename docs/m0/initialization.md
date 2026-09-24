# Engine discovery and initialization

M0 configuration baseline, 2026-09-25. This defines production behavior; the attached scripts are isolated feasibility checks, not the production adapters.

## Public configuration

```ts
// Node: discover ffmpeg and ffprobe independently on the captured PATH.
const client = createMavio({ engine: "auto", initTimeoutMs: 30_000 });

// Node: explicit installation, no fallback if an override is invalid.
const configured = createMavio({
  engine: "auto",
  native: {
    ffmpegPath: "D:/Tools/ffmpeg/bin/ffmpeg.exe",
    ffprobePath: "D:/Tools/ffmpeg/bin/ffprobe.exe",
  },
});

// Browser: application-hosted, version-matched assets.
const browser = createMavio({
  engine: "auto",
  browser: {
    assets: {
      coreURL: "/media-engine/ffmpeg-core.js",
      wasmURL: "/media-engine/ffmpeg-core.wasm",
    },
  },
});
```

The paths above are examples, not files created by this change. Browser assets must actually be deployed by the consuming app. `createMavio` performs only configuration validation and captures configuration; it does not start a process, worker or network request. Initialization starts with the first accepted job or capabilities request. Metadata counts as a job.

`engine: "auto"` selects from runtime identity; it is not an engine fallback mechanism. Native options are used only by the default Node adapter and browser options only by the default browser adapter. Applications may provide both for shared configuration. An explicit EngineAdapter with native/browser setup options is INVALID_OPTIONS because the custom adapter owns its configuration. The core's initTimeoutMs still governs its initialization and disposal obligations.

`initTimeoutMs` is a positive finite integer, default 30,000 ms, for one complete initialization attempt including discovery, loading and capability preparation. It excludes queue wait and subsequent media execution. Timeout is ENGINE_INIT_FAILED with reason TIMEOUT. This is a configurable deadline, not a performance promise.

## Native discovery

1. Capture the client's current working directory and PATH at creation. Media relative paths continue to use that captured directory.
2. Resolve FFmpeg and FFprobe independently. An explicit `ffmpegPath` or `ffprobePath` wins for that tool. Require a nonempty absolute filesystem path to a binary; relative overrides are INVALID_OPTIONS. Spaces in paths are passed as one argument and never shell-quoted by string construction.
3. Without an override, inspect captured PATH directories in order. Ignore empty and relative entries. Windows checks the exact executable name ffmpeg.exe/ffprobe.exe; other platforms use ffmpeg/ffprobe. Do not execute .cmd/.bat wrappers, search the working directory implicitly, fetch binaries or mutate PATH. An explicitly absolute PATH entry equal to the working directory is still explicit configuration.
4. Select the first matching regular file and attempt it. Missing candidate is ENGINE_UNAVAILABLE with the tool name and a setup hint. An explicit missing file must not fall back. An unlaunchable or failing selected candidate is ENGINE_INIT_FAILED; do not silently continue down PATH.
5. Invoke each selected executable with an argument array and `shell: false`, bounded diagnostic output and the remaining initialization deadline. Read `-version`, confirm expected tool identity and record the versions. Missing required FFmpeg capabilities fail early. A version string is provenance, not proof of feature compatibility.
6. Require native FFprobe for metadata in v0.1. Do not parse human FFmpeg log text as the metadata API. The bounded experiment used FFmpeg 6.1.1 and FFprobe 4.0.2; that pair worked for its fixture but does not establish arbitrary mixed-version compatibility. Production support is defined by tested pairs and capabilities, not a requirement that version strings be identical.

No installation is performed by Mavio. Applications/operators own binary installation and updates. Exact resolved paths and sanitized version details are available in opt-in diagnostics; errors must not dump PATH or media contents. Input paths and engine executable paths are separate concepts.

The Windows experiment covers explicit overrides, controlled PATH discovery, no fallback on a bad override, relative-override rejection, empty search path, timeout, pre-abort, active abort and retry. It does not prove Unix execute permissions, symlink behavior, hostile binaries, release-specific capability inventories or version-pair compatibility beyond the prior media fixture.

## Browser loading

The application supplies both coreURL and wasmURL. There is no hidden unpkg/jsDelivr default. In a browser, missing required assets are INVALID_OPTIONS before any engine request. URLs are nonempty strings, resolved against the document base URL at client creation. The initial contract supports same-origin HTTP(S) assets only; cross-origin/blob/data assets need a separate explicit design and are rejected in this baseline. Media remains local: downloading engine code is not uploading source media.

Use @ffmpeg/ffmpeg 0.12.15 with @ffmpeg/core 0.12.10 as the tested initial pair. Preserve build directory layout and matching JS/WASM files. The single-thread core runs inside the wrapper's worker; it does not run on the UI thread. Multithread core and its extra core worker are deferred.

`classWorkerURL` is an optional explicit URL for the wrapper's module worker, corresponding to the library's classWorkerURL setting. It is not the multithread core's workerURL. When omitted, the adapter uses its bundler-emitted module worker. An override must host that worker and its relative module dependencies correctly. M1 must verify emitted worker assets in real packaged consumer builds.

The tested server used Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp. Keep that as the initial documented deployment recipe. Header-free deployment, alternate CSP policies, cross-origin hosting and other browsers remain unverified. Serve JavaScript and WASM with appropriate content types and provide CSP permissions for the actual worker/module/WASM execution. Do not claim one universal CSP string without testing the deployment.

On an asset 404, worker error, malformed module, WASM failure or deadline, terminate the worker and reject with ENGINE_INIT_FAILED, a stage, and an actionable sanitized reason. Preserve the underlying cause for optional diagnostics. A failed attempt must not leave a reusable half-loaded engine. Retry only when the caller submits another job; no background retry loop. The new attempt starts a fresh worker with the same immutable configuration. Changing configuration requires a new client.

## Ownership and cancellation

The core serializes initialization with jobs; do not run duplicate simultaneous loads. A capabilities request participates in the same queue and cancellation policy. Each initialization attempt has an owning request; cancellation removes queued owners or stops active initialization before another request can retry. Already initialized capabilities may be returned without starting media execution.

On abort or disposal, stop initialization and await cleanup before settling. For later media execution, an already granted commit gate is non-cancellable; disposal waits for its publication result as specified in edge-cases.md. Native adapters terminate the child and observe process closure. Browser adapters terminate the worker rather than only rejecting a JavaScript promise. Caller abort maps to CANCELLED; an initialization deadline maps to ENGINE_INIT_FAILED/TIMEOUT. Disposal remains idempotent and makes the client permanently unavailable. On successful initialization, reuse the engine until failure, cancellation requiring restart, or disposal.

## Failure mapping

| Condition | Mavio code | Detail |
| --- | --- | --- |
| Invalid deadline, relative executable override, missing browser assets, forbidden URL | INVALID_OPTIONS | Invalid option and remediation |
| Unknown runtime | UNSUPPORTED_RUNTIME | Runtime identity |
| No executable candidate / explicit file absent | ENGINE_UNAVAILABLE | ffmpeg or ffprobe |
| Launch denied, wrong tool/version output, capability-discovery failure | ENGINE_INIT_FAILED | Sanitized reason |
| Browser asset/worker/WASM failure | ENGINE_INIT_FAILED | Loading stage and asset role |
| Initialization exceeds deadline | ENGINE_INIT_FAILED | TIMEOUT |
| Caller abort | CANCELLED | Preparing stage |
| Request after disposal | DISPOSED | No initialization starts |

## Evidence and remaining work

See `feasibility/init-native-results.json` and `feasibility/init-browser-results.json`. The experimental helpers demonstrate resource termination and retry; they do not yet implement the complete error model, shared queue, version validation, URL validation or production Mavio lifecycle. Native timeout/abort uses a deliberately long-running Node helper to make the failure deterministic. Browser timeout/abort uses a deliberately delayed core URL. Check results before interpreting a caught rejection as its intended reason.

Reproduce with `node init-native.cjs`, then `node server.cjs` and visit `http://127.0.0.1:4387/init.html`; run the displayed initialization checks. Engine package versions and tooling are pinned by the adjacent lockfile. M1 verifies consumer bundling; M2 verifies core lifecycle; M3/M4 implement and test the adapters against these contracts.

The browser experiment exposed a rejection race: terminating the worker before fixing the public reason surfaced a generic termination error. The corrected helper settles the intended TIMEOUT/CANCELLED reason before terminating, and asserts that reason in its failure checks. Production core/adapter coordination must preserve the intended primary reason while awaiting cleanup.
