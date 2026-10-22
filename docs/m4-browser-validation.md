# M4 Browser Engine Validation

## Status

M4 remains incomplete.

The verified browser route suite and installed-package checks passed
across all six browser CI configurations. Two acceptance gates remain:

1. Long-sequence WASM allocator regression.
2. Public MP4 video trim acceptance.

Passing the verified suite does not close these gates.

## Validated engine packages

| Component      | Version |
| -------------- | ------- |
| Mavio          | 0.0.3   |
| @ffmpeg/ffmpeg | 0.12.15 |
| @ffmpeg/core   | 0.12.10 |

The asset check verifies the pinned wrapper modules and core assets.
It does not independently prove initialization or media execution.

## CI compatibility matrix

The installed-package verified browser suite passed in Playwright
Chromium on these configurations:

| Runner       | Node 22 | Node 24 |
| ------------ | ------- | ------- |
| ubuntu-24.04 | Passed  | Passed  |
| windows-2025 | Passed  | Passed  |
| macos-15     | Passed  | Passed  |

This matrix covers Chromium on the listed operating systems.
Firefox, Safari, and mobile browsers are not established by these results.

Exact Node and Chromium versions are recorded in each CI run.

## Verified behavior

### Initialization and metadata

- Creating an unused client does not create a worker.
- Capabilities initialize and reuse a worker.
- Initialization download failure, timeout, and cancellation allow retry.
- Disposal during initialization terminates the worker.
- Metadata accepts bytes, Blob, and File inputs.
- Invalid media rejects and the same client recovers.
- Caller input content remains unchanged.
- Metadata responses are independent snapshots.
- Disposal leaves no active worker.

### Video preparation

- The focused MP4 resize preparation route passes.
- Prepared outputs decode after preparation workspace cleanup.
- Source content remains unchanged.
- Returned bytes remain valid after worker termination.

Internal preparation results do not establish public MP4 video trim
acceptance. That gate remains pending.

### Public audio exports

- Both audio-balanced-v1 and audio-pcm-v1 are exercised.
- Byte and Blob inputs and outputs are exercised.
- Convert and compress routes are exercised.
- Default and explicit audio selection are checked.
- Invalid media and invalid audio selection reject and allow recovery.
- Outputs decode after client disposal.
- PCM WAV payload checks verify exact source samples.

### Public audio trim

- Fractional and consecutive trim selection are checked.
- Empty audio selections reject.
- The same client recovers after rejection.
- Trimmed outputs decode after disposal.
- PCM WAV output matches the requested source samples.

### Public thumbnails

- jpeg-balanced-v1 and png-lossless-v1 are exercised.
- Byte and Blob inputs and outputs are exercised.
- Trim-relative frame selection matches an independent reference.
- Sequential resizing preserves the intended dimensions without upscaling.
- Decoded pixels match independent references.
- Empty selections reject and allow recovery.
- Outputs remain decodable after disposal.

### Active encoding cancellation

- Cancellation targets an MP3 encoding request.
- The smoke test paces that request and increases progress reporting
  frequency to create an observable cancellation window on fast runners.
- Cancellation occurs after real intermediate encoding progress.
- The cancelled job rejects without publishing output.
- The worker is terminated.
- The same client loads a replacement worker and completes recovery.
- Recovery WAV output preserves the exact stored PCM samples.
- Independent browser decoding succeeds after disposal.

The pacing adjustment belongs only to the acceptance test.
It does not change production encoding commands.

## Installed-package verification

The extended package check:

1. Creates an npm archive.
2. Installs it in a temporary consumer directory.
3. Checks public imports and browser bundling.
4. Resolves the browser entry from the installed archive.
5. Resolves the wrapper dependency from the consumer installation.
6. Installs the pinned core package as consumer-hosted browser assets.
7. Runs the verified browser route suite.

Public route checks use the installed SDK. Internal preparation smoke
tests still use repository test helpers.

Canonical filesystem paths are compared so macOS temporary-directory
aliases do not cause false failures.

## Verification commands

Run standard checks:

```powershell
npm run check
```

Run the focused verified browser suite:

```powershell
npm run check:browser:verified
```

Run installed-package browser verification:

```powershell
$env:MAVIO_PACKAGE_BROWSER = "1"

try {
  npm run test:package
}
finally {
  Remove-Item Env:MAVIO_PACKAGE_BROWSER -ErrorAction SilentlyContinue
}
```

Local machines using an installed Chrome channel may set:

```powershell
$env:MAVIO_BROWSER_CHANNEL = "chrome"
```

CI uses Playwright Chromium.

## Open acceptance gates

### Long-sequence WASM allocator regression

A combined sequence previously produced a WASM memory-access trap.
Focused passing checks do not establish that this regression is resolved.

Closure requires a reproducible regression check, a validated correction,
and successful execution of the previously failing sequence.

### Public MP4 video trim acceptance

Public browser MP4 video trim remains gated.

Closure requires validation through the public API, including fractional
and consecutive trims, empty selections, audio/video timing, output
decoding, cleanup, input preservation, and recovery.

## Completion rule

M4 reaches 100% only after both open gates close and the final validation
record reflects passing evidence. The verified browser suite is a
checkpoint, not complete M4 acceptance.
