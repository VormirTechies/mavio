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

## Native input restrictions

Default Native input demuxers are restricted to MOV/MP4-family containers,
Matroska/WebM, WAV, MP3, FLAC, and direct JPEG/PNG streams. Metadata probing
also permits image2 with filename-pattern expansion disabled for single-file
images and generated-thumbnail readback. Image-sequence processing is excluded.

Native readableContainers reflects the restricted metadata policy and installed
demuxer availability. Source-profile and operation restrictions still apply.
Concat, HLS, DASH, and unreviewed demuxers are excluded; broad Native metadata
support is deferred.

The restriction is not a filesystem or process sandbox. Use trusted Native
tools, application-controlled paths and permissions, and appropriate isolation
for hostile media.

## Diagnostics and sensitive error information

Built-in diagnostic events expose selected identifiers, lifecycle fields,
error codes, and progress values. They exclude error messages, causes,
details, paths, and media bytes.

Public errors preserve underlying causes and are not automatically redacted.
Paths, cancellation reasons, and engine or OS information may appear in
nested errors. Select approved fields before logging or transmitting errors;
avoid sending whole error objects or cause chains to telemetry.

## Experimental Browser engine assets

An optional candidate asset generator is available for local evaluation.
It is deferred for further exploration in a future release and is not
production-approved. The existing mavio-browser-assets command is unchanged.

Run the separate command with four explicit paths:

```sh
mavio-browser-assets-experimental <new-output-directory> <candidate-core-directory> <source-archive> <notice-directory>
```

The candidate directory must contain the exact pinned raw ffmpeg-core.js and
ffmpeg-core.wasm files. The source archive and collected notice files must also
match the packaged pins. Arbitrary replacement builds are rejected.

The command validates its inputs before creating a new destination, applies
the tested JavaScript stack correction, and copies the unchanged candidate
WASM, wrapper modules, source archive, and notices into manifest-backed output.
An existing destination is rejected.

Preserve the generated sources and notices with the output. These materials
remain under review; their inclusion does not establish complete redistribution
clearance. M7-D01 and M7-L01 remain open, including the x264 initialization
cleanup finding. Generation does not approve production adoption or publication.

Candidate binaries and the source archive are not bundled in the SDK package.
This route does not download or build them automatically.

## Required Browser engine kit

Normal Browser asset generation requires the pinned Mavio v2 engine kit.
Installing @ffmpeg/core@0.12.10 alone no longer satisfies this command.
The generator does not fall back to that original core.

PowerShell:

```powershell
$env:MAVIO_BROWSER_ENGINE_KIT = "C:\path\to\engine-kit-reviewed"
npx mavio-browser-assets public/mavio-engine
```

POSIX shell:

```sh
MAVIO_BROWSER_ENGINE_KIT=/path/to/engine-kit-reviewed npx mavio-browser-assets public/mavio-engine
```

The output directory must be new. The generator verifies the pinned binaries,
source archive, and notices before creating it. Preserve the generated
sources/ and notices/ directories with the deployment.

The kit is supplied separately; the SDK does not bundle or automatically
download engine binaries. Review storage is currently an unpublished draft
release, not a public distribution channel.

The separate experimental v1 command remains unchanged. Required v2 selection
does not itself establish final security/licensing acceptance or publication approval.
