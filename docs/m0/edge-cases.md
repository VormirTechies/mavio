# API edge-case decisions and scenario walkthroughs

Status: M0 design decisions resolved under the owner's instruction to resolve the remaining cases. These are normative requirements and reviewed examples, not claims that the unimplemented SDK passes runtime tests. Future contract suggestions remain welcome and must update affected examples and conformance tests.

## 1. Validation timing and precedence

`createMavio`, `from` and transformation builders throw MavioError synchronously for malformed arguments detectable without I/O. They do not initialize the engine. Terminal methods and `capabilities` always return promises; submission errors reject those promises. All pre-admission errors use stage queued with no jobId. Once admitted, assign a jobId and emit queued, including when execution can start immediately.

For a terminal submission, evaluate: disposed client, already-aborted signal, malformed terminal arguments, static plan conflicts, runtime input/output compatibility, then queue capacity. The first failure in that order wins. A failure before admission produces no progress events. Within static plan conflicts, inspect transformations in insertion order, then the terminal operation. Core may initialize/probe to discover file-dependent failures in preparing, but validation must finish before encoding.

Malformed input shape/empty path/empty input bytes or Blob is INVALID_INPUT. Invalid numbers, unknown preset IDs, conflicting settings or unsupported pipeline composition are INVALID_OPTIONS. A recognized but unsupported runtime input/output kind or missing engine feature is UNSUPPORTED_CAPABILITY. Unreadable/deleted source is IO_ERROR; a readable but corrupt or unrecognized file is INVALID_MEDIA. Include a stable reason and, where relevant, operationIndex in error details; operation remains the operation name. Do not infer format from a path extension.

## 2. Plan composition and formats

Trim, resize and extractAudio describe logical media transformations in order. Convert and compress are final encoding declarations; their location in a chain does not introduce intermediate lossy encodes. Multiple trims/resizes are allowed and use the preceding logical result. A second convert, compress or extractAudio is INVALID_OPTIONS even if identical. Convert and compress together must select the same preset. Export format, when supplied, must equal convert's format. A format must be explicit in convert or export; a preset must be explicit in convert or compress.

Each built-in preset maps to exactly one format in presets.md. A known preset paired with a different format is INVALID_OPTIONS/PRESET_FORMAT_MISMATCH. Unknown IDs are INVALID_OPTIONS/UNKNOWN_PRESET. WebM currently has no built-in preset, so all attempted built-in preset/WebM combinations fail with PRESET_FORMAT_MISMATCH; an engine advertising WebM alone does not create a usable preset. Missing encoders for a valid preset produce UNSUPPORTED_CAPABILITY.

Generic export in v0.1 produces MP4, MP3 or WAV. JPEG/PNG are produced by thumbnail only; generic image export is INVALID_OPTIONS/TERMINAL_FORMAT_MISMATCH. Thumbnail accepts preceding trims/resizes but no convert, compress or extractAudio. Metadata accepts no transformations or encoding declarations. Its result describes the source, not a hypothetical transformed output.

Repeated terminal calls create independent FIFO jobs from the immutable plan. They do not consume the pipeline or reuse a prior result. Two calls targeting the same path still compete under no-clobber publication; one may succeed and the other must fail OUTPUT_EXISTS.

## 3. Time, dimensions and padding

Require finite numeric seconds, start >= 0 and end > start. Compare intervals against the current logical timeline, not the original duration after every trim. An end beyond known logical duration is INVALID_OPTIONS/OUT_OF_RANGE; missing duration needed for trim/thumbnail is INVALID_MEDIA/UNKNOWN_DURATION. Do not silently clamp. A thumbnail requires 0 <= at < duration, so exactly duration is invalid.

Trim selects video frames with presentation timestamps in [start,end), rebases output presentation to zero, and re-encodes. If no frame/sample exists in the interval for a required output stream, reject INVALID_OPTIONS/RANGE_TOO_SHORT. For constant-frame-rate video, the selected first/last timestamps must match this rule; fractional requests do not imply synthesized sub-frame content. For variable frame rates, use actual presentation timestamps, not average frame rate. Actual encoded duration is reported and can differ from the requested interval due to frame duration and audio padding. Validate sample selection separately from packet timestamps. Decoder delay/padding must be honored where supported; otherwise expose the limitation through capability checking or UNSUPPORTED_CAPABILITY, not a false sample-exact guarantee.

Resize fits each requested box in sequence, with no upscaling/cropping, accounting for orientation and display aspect ratio. Round down only as needed for encoder alignment and report actual dimensions. If alignment would make either dimension zero, reject INVALID_OPTIONS/INVALID_DIMENSIONS. Pixel-grid rounding can approximate aspect ratio; no arbitrary distortion is allowed. Presets themselves do not resize or change frame rate. HDR, alpha, unusual channel layouts and high-bit-depth conversion require demonstrated support; no unannounced lossy fallback.

## 4. Stream decisions

MP4 video presets require a video stream and retain the first selected audio stream if present. Video-only input is valid; do not synthesize silence. Audio-only input with a video preset is INVALID_MEDIA/MISSING_VIDEO. Audio presets select the first source audio stream even without extractAudio(); extractAudio with streamIndex changes that selection using the absolute source index. A negative/noninteger index is INVALID_OPTIONS; an absent or non-audio index is INVALID_OPTIONS/INVALID_STREAM_INDEX. No audio when required is INVALID_MEDIA/MISSING_AUDIO.

Applying resize after extractAudio is an invalid composition. An earlier resize followed by audio extraction is valid if the original logical stream supported it, though the engine may eliminate unused video work. A video preset after extractAudio is INVALID_OPTIONS/STREAM_PLAN_MISMATCH. Extra streams, chapters, subtitles and tags follow the existing documented omission policy. Unsupported sample rates/layouts fail UNSUPPORTED_CAPABILITY rather than resampling/downmixing implicitly.

## 5. Input and output ownership

Capture immutable option values when building a plan; later mutation of an options object cannot change it. Keep byte-input ownership with the caller: the caller must not mutate or detach its bytes until every job using them settles. Concurrent reuse for read-only jobs is allowed. Mavio must not transfer/detach caller-owned buffers when writing to the browser engine; make an adapter-owned copy where transfer is required. Mutation by the caller violates the input contract; undetectable mutation cannot be promised a deterministic error. If detected, fail INVALID_INPUT/INPUT_CHANGED.

Path input is opened afresh for each job. The caller must keep it stable through settlement; there is no atomic filesystem snapshot promise. Missing/revoked access is IO_ERROR. Detected file changes are IO_ERROR/INPUT_CHANGED; unobservable changes remain outside the input guarantee. Blob/File input uses the platform's immutable blob value. Output bytes/Blob are detached from engine storage and remain usable after cleanup/disposal. The caller owns later changes, deletion and object-URL revocation.

## 6. Publication and cancellation: explicit commit gate

Introduce ExecutionEngineContext.beginCommit(): boolean. The engine calls it exactly once after the encoded output is complete and validated and before handing off bytes/Blob or starting the final no-clobber filesystem publication. The core synchronously grants or denies that gate. Before the gate, the first recorded abort, timeout or execution failure fixes the primary outcome. If denied, publish nothing and clean up. If granted, the job enters a non-cancellable finalization window; later abort/dispose waits for its outcome. This closes the unimplementable gap between checking a signal and an asynchronous filesystem commit.

Gate acquisition is not success. Publication can still fail with OUTPUT_EXISTS or IO_ERROR. After successful publication, resolve completed even if subsequent temporary-resource cleanup fails; attach cleanup warnings to the successful result. Do not reject a job as cancelled or failed after its final output has been published. For byte/Blob output, complete cleanup before granting the gate whenever possible. For metadata/capabilities, core commits the prepared result itself without invoking an output adapter gate.

The adapter must not resolve execute before successful gate acquisition and handoff/publication. Violation is EXECUTION_FAILED/ENGINE_CONTRACT_VIOLATION and the adapter is invalidated. Gate denial never produces a result. The core must not perform a post-return signal check that changes an already committed outcome.

For paths, stage a unique job-owned file in the destination directory, verify it, then use a no-clobber publication primitive. An initial existence check is only an optimization. A competing writer at commit yields OUTPUT_EXISTS; never overwrite its file. Existing directory/symlink destinations count as occupied. The destination parent must exist. If no safe primitive is available, fail UNSUPPORTED_CAPABILITY before encoding. Source=destination is rejected as OUTPUT_EXISTS when occupied; no in-place transformation.

Disk exhaustion or permission failures before successful publication are IO_ERROR. Remove only job-owned temporary paths. Preserve the primary failure and record secondary cleanupIssues on MavioError. If cleanup is the only failure before the gate, use CLEANUP_FAILED. A cleanup warning after successful publication uses MediaResult.warnings and never deletes the published output. Leaked/uncertain engine state is invalidated before later jobs.

## 7. Queue, progress and observers

maxQueuedJobs is an integer >= 0, default 16, excluding the active job. Zero means accept work only while idle. Capabilities/metadata use the same queue. Valid submissions on a full queue reject QUEUE_FULL with no engine call. A cancelled queued job is removed and emits cancelled; active jobs continue independently.

Stages advance queued → preparing → running → finalizing → completed; failures/cancellation can terminate before completion. Each accepted job has one terminal event, dispatched before settling its promise. Core owns stage order and ignores late engine events after a terminal state. Synchronous callback exceptions and returned rejected thenables are isolated; callbacks cannot delay the job. Supply immutable event snapshots. Observer-triggered abort/dispose is allowed and obeys the commit gate.

Deliver all stage transitions and terminal events; throttle percent-only updates to at most ten per second per job. Do not fabricate percentages. Known percentages never decrease, remain below 100 before successful completion, and completed includes 100. When no defensible mapping is available, omit percent, including during probing. Failed/cancelled events never invent 100. No events exist for pre-admission rejections.

## 8. Disposal and retry

The first dispose call immediately marks the client disposed. New builders throw DISPOSED and terminal submissions reject DISPOSED; existing pipelines cannot bypass that state. It cancels queued jobs and active work that has not acquired the commit gate, and waits for a gate-owning job plus all resource cleanup. Repeated dispose calls share the same promise/outcome and never restart cleanup. Cleanup-only disposal failure rejects CLEANUP_FAILED, but the client remains permanently disposed.

Ordinary operation failure does not dispose the client. Reuse an engine only if its adapter can guarantee a clean state; otherwise terminate it and lazily initialize on the next accepted job. There is no automatic retry of a failed job and no replay after publication. Queued jobs remain queued across recoverable failures; each has its own result. Initialization timeout/abort stops the owning attempt; a subsequent job may start a fresh attempt within its own deadline.

## Scenario walkthroughs and future conformance cases

| ID | Scenario | Required outcome |
| --- | --- | --- |
| E01 | convert balanced + compress small | INVALID_OPTIONS, no encoding |
| E02 | convert MP4 + export WAV | INVALID_OPTIONS |
| E03 | duplicate identical convert | INVALID_OPTIONS |
| E04 | trim [5,15), then [2,4) | Logical source interval [7,9) |
| E05 | resize 640x360, then 1280x720 | Second resize cannot upscale |
| E06 | thumbnail after compress | INVALID_OPTIONS |
| E07 | metadata after trim | INVALID_OPTIONS |
| E08 | MP4 preset paired with WebM | PRESET_FORMAT_MISMATCH |
| E09 | JPEG via export | TERMINAL_FORMAT_MISMATCH |
| E10 | valid MP4 preset, encoder absent | UNSUPPORTED_CAPABILITY |
| E11 | end > duration / thumbnail at duration | OUT_OF_RANGE |
| E12 | trim requires unknown duration | UNKNOWN_DURATION |
| E13 | interval contains no required frame/sample | RANGE_TOO_SHORT |
| E14 | video-only input to video preset | Success without audio |
| E15 | audio-only input to video preset | MISSING_VIDEO |
| E16 | requested audio index is a video stream | INVALID_STREAM_INDEX |
| E17 | input removed before opening | IO_ERROR |
| E18 | browser engine writes caller bytes | Adapter copies; original buffer remains usable |
| E19 | mutate options after building plan | Original captured options apply |
| E20 | same pipeline exported twice | Two independent job IDs/results |
| E21 | abort recorded before commit gate | Gate denied, CANCELLED, no publication |
| E22 | abort after gate, publication succeeds | Completed result wins |
| E23 | abort after gate, another writer owns output | OUTPUT_EXISTS; competing output preserved |
| E24 | publication succeeds, temp cleanup fails | Completed result with CLEANUP_FAILED warning |
| E25 | encoding fails and cleanup also fails | Primary execution error with cleanupIssues |
| E26 | queue full and submission already aborted | CANCELLED takes precedence, no events |
| E27 | disposal and later submission already aborted | DISPOSED takes precedence |
| E28 | progress callback throws/rejects | Job continues; rejection is observed/isolated |
| E29 | disposal during non-cancellable finalization | Await result/cleanup; no new jobs |
| E30 | repeated dispose after cleanup failure | Same rejected disposal outcome; client stays disposed |
| E31 | initialization fails; later job submitted | Fresh attempt, no automatic replay |
| E32 | rejected submission / successful metadata | No events / one terminal completed event respectively |

The walkthrough resolves specification outcomes. M2 owns executable scheduling, event and fake-adapter cases; M3/M4 own filesystem/worker failures; M5 owns media boundaries and stream combinations. No row is represented as a passing runtime test at M0.
