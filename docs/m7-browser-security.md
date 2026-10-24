# M7 Browser security review

## Status

Local review and focused verification completed on 2026-10-24.
No new Browser runtime defect was demonstrated in the inspected scope.
This is not comprehensive security clearance or a deployment penetration test.

## Asset configuration and trust

Configuration resolves asset URLs against the captured document base and
requires HTTP(S) URLs matching the page origin. Credentials, fragments,
control characters, and surrounding whitespace are rejected.

Tests cover a cross-origin document base, alternate ports and schemes,
invalid asset objects, immutable captured configuration, and HTTP localhost.

These checks validate configured URLs. They do not authenticate served content,
prove redirect destinations, enforce deployment CSP, or protect an application
whose same-origin asset hosting has been compromised.

Core JavaScript and wrapper worker modules execute code. Applications must
control their hosting, deployment access, redirects, and dependency provenance.
Do not point configured asset URLs at user-controlled uploads or responses.

## Generation and integrity

The accepted generator verifies pinned upstream core JavaScript and WASM
SHA-256 values and the wrapper package version. It applies the reviewed
stack-restoration correction and copies the unchanged WASM and wrapper modules.

The generator requires a new destination and writes a manifest containing
generated-file hashes. The manifest records contents; it is not independently
authenticated merely because it exists beside those files.

The inspected generator does not independently pin every wrapper module hash.
Wrapper dependency provenance remains part of M7-04 and final package review.

Runtime initialization does not enforce the generated manifest's hashes.
Applications must deploy the reviewed generated directory intact and prevent
unauthorized modification.

## Worker and input boundaries

The installed wrapper uses a dedicated module Worker and message IDs to match
responses. Worker responses are part of the trusted engine implementation,
not an authenticated protocol with an untrusted third party.

The wrapper transfers the complete ArrayBuffer underlying a supplied Uint8Array.
Mavio prepares an independently owned copy of the visible caller byte view
before staging. This avoids transferring the caller's original buffer or
surrounding bytes from a larger view.

Blob preparation checks cancellation, buffer type, and returned byte count.
Browser path inputs are rejected.

The reviewed metadata route creates a per-job virtual workspace, checks for
stale probe output, validates returned text and parsed metadata, and cleans
the workspace. Failure discards the worker when possible.

The reviewed MP4 output route validates binary output, copies output bytes and
metadata before cleanup, and handles worker termination on failure.
Focused audio and thumbnail checks supplement output-ownership coverage.

Worker filesystem separation is not a guarantee against engine parser flaws
or compromised worker JavaScript. The worker has the privileges the Browser
platform and application deployment grant it.

## Initialization, cancellation, and disposal

Initialization captures configuration before asynchronous loading, observes
cancellation around import/construction/loading, and terminates failed workers.
Cancellation and failure retain structured primary outcomes and cleanup issues.

Worker-call cancellation records cancellation before terminating the worker.
Callers must discard the cancelled worker before accepting more work.
These lifecycle controls do not establish a memory budget or CPU sandbox.

## Deployment guidance

Follow [Browser engine assets](browser-engine-assets.md) for generation and
configuration and [consumer examples](../examples/README.md) for the tested
local server.

Deploy JavaScript and WASM with appropriate content types. Review actual asset
responses, worker dependencies, redirect behavior, and application CSP.
The local examples provide the accepted COOP/COEP headers; this review does
not certify an arbitrary production server's headers or CSP.

Use a versioned, application-controlled asset directory when updating assets.
Preserve the manifest for deployment verification, and compare deployed content
with the reviewed build through the application's deployment process.

## Verification

- All 87 focused Browser tests passed without failures, cancellations, or skips.
- Suites covered configuration, initialization, input ownership, virtual
  workspaces, worker calls, probing, MP4/audio exports, and thumbnail bytes.
- Pinned asset verification passed for wrapper 0.12.15 and core 0.12.10.
- Asset verification checked seven wrapper JavaScript modules and reported
  the expected upstream core JavaScript and WASM hashes.
- Five Browser core regression tests passed, covering CLI filesystem aliases,
  the stack-control oracle, rejection of changed/already patched cores, and
  stack restoration for FFmpeg and FFprobe.
- Diff whitespace checks passed.

The asset inventory check does not execute media or initialize a real Browser.
Injected-worker tests are distinct from installed-package real-engine acceptance.
Existing M4/M6 evidence remains separate; final candidate verification and fresh
cross-platform CI are required under M7-09.

See [M7 acceptance](m7-acceptance-matrix.md) for remaining security, dependency,
licensing, package, and release-candidate tasks.
