# Opt-in diagnostics

Use the optional onDiagnostic client option to observe structured job events.
The SDK does not automatically print these events or send them over a network.

## Example

This Node example requires separately installed FFmpeg and FFprobe on PATH.

```js
import { createMavio } from "@vormir/mavio/node";

const client = createMavio({
  onDiagnostic(event) {
    if (event.type === "job-error") {
      console.info(event.jobId, event.engineId, event.stage, event.code);
    } else {
      console.info(event.jobId, event.stage, event.percent);
    }
  },
});

try {
  await client.capabilities();
} finally {
  await client.dispose();
}
```

Browser clients accept the same option alongside their required generated
asset configuration. See [the public recipes](m5-recipes.md).

## Event fields

Every event includes type, jobId, engineId, runtime, and stage.

| Type         | Additional fields | Meaning                                                       |
| ------------ | ----------------- | ------------------------------------------------------------- |
| job-progress | Optional percent  | A progress delivery for an admitted job                       |
| job-error    | code              | The stable error code for an admitted failed or cancelled job |

A progress event can have a terminal completed, failed, or cancelled stage.
An error event follows the failed/cancelled progress event and retains the
failure stage; for example, preparing rather than the terminal failed stage.

Unknown percentages are omitted. These events do not add engine-level
percentage mapping, timing measurements, memory metrics, or raw logs.

## Delivery and observer behavior

- Diagnostics are disabled when onDiagnostic is omitted.
- The option must be a function when provided; invalid values are rejected.
- The callback reference is captured when the client is created.
- Events are frozen snapshots containing primitive fields.
- Delivery is asynchronous through microtasks.
- A stage may already have started before its diagnostic callback runs.
  In particular, a queued diagnostic does not guarantee that initialization
  has not started.
- Observer return values are not awaited.
- Synchronous throws and returned rejected promises are isolated from jobs.
- A never-settling observer promise does not prevent the job from settling.
- Synchronous callback work still consumes the JavaScript event loop.
  Keep observers short and perform expensive handling elsewhere.
- Existing onProgress callbacks retain their synchronous delivery behavior.
- Explicit cancellation or disposal called by an observer still has its
  normal lifecycle effect. Diagnostics are not a publication-control hook.
- Rejected submissions, including pre-aborted requests and queue overflow,
  are not admitted jobs and do not emit these diagnostic events.
- Client creation and disposal do not have separate diagnostic event types.

Use terminal method results and errors as the authoritative job outcome.
Diagnostic delivery is not an additional completion barrier.

## Data boundaries

The reporter copies an explicit field allowlist. It does not include source
media, input/output paths, executable paths, asset URLs, engine arguments,
raw logs, error messages, error details, cleanup text, or original causes.

The engineId of a custom adapter is caller-controlled. Give adapters a
non-sensitive identifier; the SDK does not redact secrets embedded in that ID.

Original causes and other public error fields remain available separately
and can contain sensitive information. Applications control their own logging.

## Local verification

- Browser and Node consumer type configurations passed.
- Eleven focused diagnostics tests cover asynchronous snapshots, approved
  fields, disabled behavior, invalid options, observer capture, preserved
  progress, safe error events, observer failures, pre-abort, and lifecycle actions.
- The combined diagnostics, progress, capability-client, and failure-precedence
  run passed all 37 tests without failures, skips, or cancellations.
- Public type checks cover readonly events, discriminated event fields,
  forbidden path/cause access, and invalid observer options.

These runtime checks use injected engines and do not establish new real-media
acceptance or a complete privacy audit.
Milestone-wide package checks and fresh CI remain pending.
