# M4 Browser Engine Validation

## Status

Both remaining engineering gates pass locally using generated, corrected
browser assets: the long-sequence WASM memory regression and public MP4 video
trim acceptance. The verified suite now includes both checks.

M4 release acceptance still requires a fresh CI matrix for these changes.
The earlier sixteen passing jobs cover the previous baseline, not these edits.

## Validated engine packages

| Component      | Version |
| -------------- | ------- |
| Mavio          | 0.0.3   |
| @ffmpeg/ffmpeg | 0.12.15 |
| @ffmpeg/core   | 0.12.10 |

The asset check verifies the pinned wrapper modules and core assets.
It does not independently prove initialization or media execution.

The accepted configuration adds Mavio's stack-restoration correction to the
core JavaScript and leaves the WASM unchanged. Generate and host assets using
the packaged `mavio-browser-assets` command; see
[Browser engine assets](browser-engine-assets.md). The unmodified upstream
JavaScript remains affected and is not the accepted configuration.

## CI compatibility matrix

The previous installed-package baseline passed in Playwright Chromium on these
configurations. This matrix must rerun with the new regression, public MP4 trim,
and packaged asset-generation checks:

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

### Public MP4 video trim

- Both MP4 presets, with and without AAC audio, are exercised.
- Sixteen public trims cover byte and Blob output. Byte input uses fractional
  trims; Blob input uses consecutive trims.
- Fractional trims retain three frames at 0.041667, 0.125, and 0.208333 seconds.
- Consecutive trims retain two frames at 0 and 0.083333 seconds.
- Audio presentation starts at zero and lasts exactly 0.25 or 0.125 seconds.
- The pinned AAC decoder's final-frame padding is checked separately from
  presentation duration (12,288 or 6,144 decoded samples).
- Empty video selections reject; the same client recovers for each matrix case.
- Caller bytes and Blob content remain unchanged.
- Thirty-three retained public MP4 outputs decode after client disposal.
- Preparation cleanup, overwrite protection, and worker termination remain
  checked in the combined long-sequence smoke.

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

The installed package's asset CLI is invoked through npm, and its generated
files are used for the public route checks. The package must include the asset
generator, and its manifest must identify the stack-restoration correction.

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

## Acceptance evidence, 2026-10-23

The final local command passed on Windows x64, Node v24.22.1, and
Chrome 156.0.8078.47:

```powershell
$env:MAVIO_BROWSER_CHANNEL = "chrome"
$env:MAVIO_PACKAGE_BROWSER = "1"
npm run check
```

Results: lint, formatting, build, type checks, 877 SDK tests, six helper tests,
packed imports and browser bundling, the installed asset CLI, and all eight
installed-package browser checks passed. The asset manifest records corrected
JavaScript SHA-256
`c3f8f02416f82a9d18eb549d7e44725405b95f002b503bcfed02acba449ac79b`
and unchanged WASM SHA-256
`9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7`.

The local full log is
`C:\Users\vicky\AppData\Local\Temp\mavio-m4-final-check.log`.
This is local evidence; no updated remote CI result is claimed.

### Long-sequence WASM stack regression

The complete recorded sequence reproduces a memory-access trap at call 612
with the unmodified core. The pinned binding catches native aborts without
restoring the shadow stack. Saving/restoring the stack around both native
FFmpeg and FFprobe entry points corrects the recorded regression.

The permanent fixture is `testing/fixtures/browser/long-sequence.json.gz`.
`node.exe scripts/check-browser-regression.mjs` requires the control to reproduce
and two corrected full-trace runs to decode successfully. Both corrected runs
must match the fixed fresh-worker PCM reference byte-for-byte (6,144 samples).
Every original filesystem and command call is retained in original order.

This check passed locally in Chrome 156.0.8078.47 on Windows x64 with
Node v24.22.1. It does not establish safety for unmodified assets or arbitrary
future core builds. Hash checks reject unsupported core builds.

### Public MP4 video trim acceptance

The adapter's provisional public-video-trim restriction has been replaced by
feature checks. The combined acceptance route passes through the public API,
with the timing, decoding, preservation, and recovery checks listed above.
The installed SDK and generated assets are tested together.

## Completion rule

The two engineering gates have passing local checks for the corrected asset
configuration. M4 release acceptance reaches 100% after the updated CI matrix
passes and this record includes that fresh evidence. Previous CI results must
not be reused as evidence for these edits.
