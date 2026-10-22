# Browser engine assets

Mavio's accepted browser configuration uses @ffmpeg/ffmpeg@0.12.15 and the
@ffmpeg/core@0.12.10 ESM core with Mavio's stack-restoration correction.
The unmodified upstream JavaScript still reproduces the long-sequence trap.
Copying the upstream core directly is not the accepted release configuration.

## Generate assets in an application

After installing Mavio, install the pinned core and generate a new asset directory:

```sh
npm install --save-dev --save-exact @ffmpeg/core@0.12.10
npx --no-install mavio-browser-assets public/mavio-engine
```

The parent directory must exist; the destination must be new. Generation fails
instead of overwriting an existing directory. To update assets, generate to a
new versioned directory and update the application URLs.

The command ships in the Mavio archive. It verifies the upstream ESM JavaScript
and WASM SHA-256 values, checks the wrapper version, restores the stack in
`finally` blocks around both native entry points, and copies the unchanged WASM
and wrapper modules. `manifest.json` records hashes for the generated files.
Unknown core builds are rejected rather than patched heuristically.

Serve the directory on the application's origin and configure:

```js
import { createMavio } from "@vormir/mavio/browser";

const client = createMavio({
  browser: {
    assets: {
      coreURL: "/mavio-engine/ffmpeg-core.js",
      wasmURL: "/mavio-engine/ffmpeg-core.wasm",
      classWorkerURL: "/mavio-engine/wrapper/worker.js",
    },
  },
});
```

The host must serve JavaScript and WASM with appropriate MIME types. The SDK
does not download, alter, or replace an application's configured assets at run
time. Hosting the generated assets is a deployment requirement.

## Why the correction is required

The pinned binding invokes native FFmpeg/FFprobe directly and catches native
abort exceptions. It resets the exit code and timeout but does not restore the
WASM shadow stack. The correction saves the stack before each native invocation
and restores it on both normal and exceptional exits. It preserves native error
handling, command arguments, filesystem operations, and the original WASM.

Emscripten documents the need to restore the shadow stack when catching an
exception in JavaScript and continuing to use the module:
[C++ Exceptions Support](https://emscripten.org/docs/porting/exceptions.html#handling-c-exceptions-from-javascript).

The permanent regression fixture contains all 612 original calls. A bounded
control runs `-version` through each original native entry point and measures
its stack loss, then verifies zero loss with the correction. Instrumentation
reads the stack pointer without changing the binding bodies or stack position.
Two corrected full-trace runs must reach call 612 successfully and produce
PCM byte-equal to a fresh-worker reference of 6,144 mono samples. No recorded
calls are omitted or reordered in either corrected replay.

The unmodified full trace remains available through
`scripts/replay-browser-regression.mjs`. On some CI hosts, executing its exhausted
stack crashes the renderer instead of producing a catchable WASM trap. Such a
run remains `INCONCLUSIVE` and is never accepted as reproduction evidence.

```powershell
$env:MAVIO_BROWSER_CHANNEL = "chrome"
node.exe scripts/check-browser-regression.mjs
```

The complete verified suite also generates assets using the helper shipped in
the SDK under test, including when testing an installed npm archive.
