# Browser regression trace minimization

Run in VS Code PowerShell using the same browser channel as the reproduction:

```powershell
$env:MAVIO_BROWSER_CHANNEL = "chrome"
node.exe scripts/minimize-browser-regression.mjs `
  C:\Users\vicky\AppData\Local\Temp\mavio-browser-regression.json `
  C:\Users\vicky\AppData\Local\Temp\mavio-minimization-current `
  100
```

Arguments are the trace, output directory, and maximum browser runs for this
invocation (default 100). Each run uses a fresh browser and workers through the
standalone replay. The target is always the last original call, never the last
position in a reduced sequence. The fresh-worker PCM reference remains fixed to
the original captured input.

The reducer removes chunks and restores transitive filesystem dependencies:
file producers, parent directory setup, prior mutations of reused paths, and
child mutations required by directory operations. It understands the recorded
absolute-path exec/ffprobe dialect, with ffprobe output specified by `-o`.
Dependencies are conservative and may retain unnecessary calls. It does not
rewrite commands, inject replacement files, or claim a globally minimal trace.

Only `REPRODUCED` at the original target with the matching memory trap permits
a reduction. `NOT_REPRODUCED` requires successful target decoding and byte-equal
reference PCM. `DIVERGED` and `INCONCLUSIVE` are recorded separately and never
accepted as reproductions. The last structured replay result and matching
process exit code are required; process exit alone is insufficient.

The output directory contains `checkpoint.json`, the current `retained.json`,
and each trial's retained IDs and process log. Repeat the command to resume;
the best sequence is revalidated before cached trial results are used.
Checkpoints are tied to trace bytes, the scripts and core-correction helper,
Node version, browser channel, and correction mode. Use a new directory after changing browser or FFmpeg installs
(including automatic browser updates); those binaries are not fingerprinted.

`BUDGET_EXHAUSTED` means more search remains. `DEPENDENCY_CLOSED_SEARCH_COMPLETE`
means no tested dependency-closed single-call removal reproduced the trap.
Inspect divergent and inconclusive trials before drawing minimality conclusions.
Neither status closes the WASM correction gate or public MP4 acceptance gate.

Verify the dependency/oracle helpers:

```powershell
node.exe --test scripts/minimize-browser-regression.test.mjs
```

## Initial validation, 2026-10-23

The 24-run Chrome pass reproduced the full 612-call trace at original call 612.
All 23 reduced candidates returned `NOT_REPRODUCED`: target decoding succeeded
and PCM matched the fixed reference. No candidate diverged or was inconclusive.
The pass ended with `BUDGET_EXHAUSTED`, retaining all 612 calls; this is not a
minimality result. The checkpoint and per-trial evidence are in
`C:\Users\vicky\AppData\Local\Temp\mavio-minimization-current`.

All three focused helper tests, ESLint, formatting, and `git diff --check`
passed. At that checkpoint both M4 acceptance gates remained open.

## Subsequent correction

The original trace is now retained as
`testing/fixtures/browser/long-sequence.json.gz`; both replay and minimizer accept
gzip traces. The permanent paired regression check is
`node.exe scripts/check-browser-regression.mjs`. It reproduces with the unmodified
core and requires two corrected replays to match the reference. See
[Browser engine assets](browser-engine-assets.md) for the packaged correction.
