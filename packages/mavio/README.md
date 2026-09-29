# @vormir/mavio

JavaScript multimedia SDK for browser and Node.js runtimes.

## Current implementation

Version 0.0.3 implements the core against injected engine adapters. The package remains private and has not been published to npm.

Public entry points:

- `@vormir/mavio`
- `@vormir/mavio/browser`
- `@vormir/mavio/node`

Each entry exposes `createMavio`, `SDK_VERSION`, and public contract types. The root entry selects the Node or browser implementation through package export conditions.

## Engine requirement

Call `createMavio({ engine })` with a complete `EngineAdapter` matching the selected runtime.

Client creation performs configuration validation without initializing the engine. Initialization occurs on the first accepted job or capability request.

Each adapter instance belongs to one client and cannot be reassigned after disposal. Create a fresh adapter instance for another client.

Default native and browser adapters are pending. Calling `createMavio()` or selecting `engine: "auto"` currently throws `ENGINE_UNAVAILABLE`.

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

Core behavior is exercised with mock adapters. A Chromium package smoke test also exercises the browser factory and metadata lifecycle with a mock adapter.

Real encoding, frame/sample accuracy, native no-clobber publication, worker termination, and broader browser compatibility require later engine integration tests.

## License

MIT.
