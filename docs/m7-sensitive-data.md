# M7 sensitive-data review

## Reviewed boundaries

Local review on 2026-10-24 inspected shared error construction, diagnostic
reporting, Native process handling, and Browser worker cancellation.
Existing diagnostics and Native process tests passed.

The source scan found no matches for the inspected console and direct
stdout/stderr logging patterns. This is a bounded source scan, not a
complete information-flow or telemetry audit.

## Diagnostic events

The built-in reporter copies an explicit field list: engineId, runtime,
jobId, stage, event type, and either error code or optional progress percent.
It does not spread errors or adapter responses into events.

Messages, causes, details, media bytes, and paths are excluded from this
payload. Identifiers may still be sensitive when applications or adapters
choose meaningful values. Applications control their diagnostic observers
and any subsequent storage or transmission.

## Public errors

MavioError retains arbitrary causes. Cancellation reasons, OS errors,
wrapper failures, nested errors, and termination failures may contain
paths, supplied values, or other sensitive information.

Raw errors, stacks, causes, and details are not a redacted logging contract.
Applications should select approved fields before sending error information
to logs, analytics, support systems, or remote services. Do not rely on
JSON serialization behavior as a privacy control.

Native nonzero-exit errors retain status information without attaching
captured stdout/stderr. The process runner bounds combined captured output
by bytes. Successful internal process results still contain output strings.

Browser cancellation retains the supplied cancellation reason and can
retain a termination failure through AggregateError.

## Remaining scope

Temporary-media, source-map, and example logging reviews are recorded below. Final package contents and deployment-specific logging remain pending.
M7-D01 dependency assessment remains open independently.

## Temporary media and storage boundaries

Native byte input is copied into an adapter-owned directory under the OS
temporary directory. Path exports use destination-side staging. Staged media
is not encrypted by Mavio. Cleanup waits for tracked reads and writes,
validates the owned directory location, and supports retry after failure.

Normal cleanup is not secure erasure. Crashes, forced process termination,
filesystem errors, backups, or OS behavior can leave recoverable data.
Applications handling sensitive media must account for temporary storage,
access controls, retention, and cleanup failures.

Browser workspaces use fresh worker-filesystem directories. Cleanup removes
flat entries and rejects unsafe names or unexpected directories. The helper
does not terminate the shared worker. Operation-level failure handling and
client disposal manage worker lifetime. Worker termination is not a promise
of immediate physical memory erasure or protection from browser/OS inspection.

Returned media bytes and published output files are intentional results
owned by the caller. Workspace cleanup does not revoke or erase them.

Existing Native and Browser workspace tests passed locally.

## Network and persistent-storage scan

The inspected SDK TypeScript source had no matches for direct fetch,
XMLHttpRequest, WebSocket, sendBeacon, HTTP URL literals, localStorage,
sessionStorage, indexedDB, document.cookie, or caches access.

This pattern scan does not cover dependency internals, computed calls,
custom adapters, application observers, asset servers, or deployment logs.
Browser wrapper/core initialization loads configured engine assets.
No claim of network-free initialization or complete telemetry absence follows.

## Review status

Local SDK error, diagnostic, workspace, and storage boundaries are reviewed.
Example logging is reviewed below. Final packaged artifacts and deployment-specific behavior remain pending. M7-D01 remains open independently.

## Example logging and generated source maps

The Node example writes source duration, progress, the output path, warning
counts, and failure code/message to its local console. Diagnostic output is
opt-in through MAVIO_EXAMPLE_DIAGNOSTICS. These are operator-visible examples,
not a redacted logging contract. Paths, filenames, duration, identifiers, and
messages may be sensitive. Applications that capture CLI output must apply
their own logging and retention policy.

The local example server binds to 127.0.0.1. Request failures return a generic
404 response without printing their underlying errors. Listener failures print
their message locally. The startup message exposes the loopback URL and port.
This development server is not a production deployment-security assessment.

All 133 generated source maps inspected in the current dist directory contained
no absolute source references or embedded source strings under the recorded
checks. Relative source references remain present. Final packed artifacts
require a fresh check under M7-08.

## Bounded local verification

- 19 diagnostic and Native process tests passed.
- 24 Native and Browser workspace tests passed.
- Authored example logging was inspected in context.
- SDK source scans found no matches for the specified direct network and
  persistent browser-storage patterns.
- 133 generated source maps passed the recorded inspection.

This completes the local review of the stated SDK and example boundaries.
It does not establish secure erasure, crash-proof cleanup, absence of all
network activity in dependencies, or safety of logging arbitrary errors.
Final package/deployment checks and the independent M7-D01 gate remain open.
