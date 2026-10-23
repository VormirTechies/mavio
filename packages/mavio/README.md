# @vormir/mavio

JavaScript multimedia SDK for browser and Node.js runtimes.

## Current implementation

Version 0.0.3 implements the core contracts plus native and browser engine
adapters. The package remains private and has not been published to npm.

Public entry points:

- `@vormir/mavio`
- `@vormir/mavio/browser`
- `@vormir/mavio/node`

Each entry exposes `createMavio`, `SDK_VERSION`, and public contract types. The root entry selects the Node or browser implementation through package export conditions.

## Engine requirement

The Node and browser entry points provide their runtime-specific default
adapters. A custom adapter is optional.

For Node, use `createMavio()` when FFmpeg and FFprobe are available on PATH.
Alternatively, supply absolute executable paths through
`createMavio({ native: { ffmpegPath, ffprobePath } })`.

For browsers, supply the generated application-hosted assets through
`createMavio({ browser: { assets } })`.

To use a custom adapter, pass `createMavio({ engine })` with a complete
`EngineAdapter` matching the selected runtime. Do not combine an explicit
adapter with `native` or `browser` configuration.

Client creation validates configuration. Engine initialization occurs on the
first accepted job or capability request.

Each adapter instance belongs to one client and cannot be reassigned after
disposal. Create a fresh adapter instance for another client.

The browser adapter accepts `createMavio({ browser: { assets } })`. Generate the
accepted browser assets using the packaged command:

```sh
npm install --save-dev --save-exact @ffmpeg/core@0.12.10
npx --no-install mavio-browser-assets public/mavio-engine
```

The parent directory must exist and the output directory must be new. Host the
generated files on the application's origin and pass these URLs:

```js
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

The generated JavaScript includes Mavio's stack-restoration correction for the
pinned core. The WASM is unchanged. The unmodified upstream JavaScript remains
affected by a long-sequence memory trap and is not the accepted configuration.
Generation verifies source hashes and records output hashes in `manifest.json`.

Native tools must be installed separately. Omitting executable paths enables
discovery on the captured PATH; explicit paths must be absolute.

Always await `client.dispose()` when the client is no longer needed.

## Core behavior

- Immutable pipelines with explicit format and preset selection.
- Source metadata and validated processing plans.
- Serialized jobs with bounded queue capacity.
- Cancellation coordinated with an explicit publication gate.
- Ordered progress events and isolated observer failures.
- Idempotent disposal and cleanup-aware error reporting.
- Validation and independent snapshots of adapter responses.

Pipeline methods express transformations; the adapter performs actual media processing.

## Runtime inputs and outputs

| Runtime | Input                         | Output                 |
| ------- | ----------------------------- | ---------------------- |
| Browser | Blob/File, Uint8Array         | Blob, Uint8Array       |
| Node    | Local path, Uint8Array/Buffer | Local path, Uint8Array |

Node paths resolve against the directory captured when the client is created.

Callers must keep input bytes unchanged until their jobs settle. Adapters must not mutate or transfer caller-owned input buffers. Returned byte and Blob outputs remain usable after client disposal.

## Validation scope

Core contracts are exercised with mock adapters. Real browser acceptance checks
exercise metadata, MP4 exports and trims, audio exports and trims, thumbnails,
cancellation, cleanup, and recovery through installed-package public APIs.
Acceptance applies to generated assets and the tested Chromium configurations;
other browser families require separate verification.

[Public API recipes](../../docs/m5-recipes.md)

## License

MIT.
