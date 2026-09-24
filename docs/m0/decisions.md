# M0 architecture decisions

Status: M0 design baseline complete. The entries below preserve decision history; later resolution entries and the linked final specifications supersede earlier open-question wording. Production compatibility evidence remains assigned to later milestones.

## ADR-001: Intent-based core and engine isolation

Preserve the agreed architecture: public API → normalized plan → core validation/scheduling → engine execution. Core owns lifecycle, queueing, error normalization and output publication policy. Engines own probing, actual capability reporting, media execution and their temporary resources. Engine code must not import docs/playground/framework code.

The adapter's execute promise settles only after cleanup and successful publication or failure handling. Cancellation must be checked before publication. Core verifies that an adapter result matches the requested output kind. Shared conformance tests enforce these obligations; an interface alone is insufficient.

## ADR-002: Explicit client ownership

Use `createMavio().from(input)` instead of a hidden global engine behind `mavio(input)`. An explicit owner makes engine initialization, queue bounds, cancellation and disposal testable. Immutable pipelines can share a client safely. The cost is one additional setup step. A convenience facade can follow only if ownership stays clear.

## ADR-003: One package, runtime-specific boundaries

Publish `@vormir/mavio` only. Keep core, operations, presets and engines internal initially. M1 selects conditional exports or explicit runtime entry points through consumer tests. No Node filesystem/process imports may enter browser bundles; no browser WASM assets should be eagerly loaded by an SDK import.

Planned monorepo locations: `packages/mavio`, `apps/docs`, `apps/playground`, `examples/vanilla-js`, `examples/vanilla-ts`, `examples/node`, `testing/fixtures`, `testing/conformance`, `docs/architecture` and `docs/decisions`. M0 documentation is recorded under `docs/m0`; M1 may link it without duplicating authority.

## ADR-004: Explicit support and local-only execution

Select the default engine from the runtime; allow a supplied adapter instance for deterministic control and future engines. Capability checks use the installed build, source probe and whole plan. Unknown support never counts as confirmed support. No silent upload, engine switch, format change or codec substitution. The public API does not expose raw shell commands. Engine-specific advanced configuration requires a separate typed proposal; arbitrary flag escape hatches are deferred.

## ADR-005: Conservative resource and output policy

One active job per client; bounded FIFO queue; AbortSignal cancellation; explicit disposal. Browser outputs are detached from the engine filesystem before cleanup. Native execution passes argument arrays directly to a process API, never interpolated shell text. Native executable location must be configurable in the eventual Node engine factory. Binary discovery, browser asset URLs, worker setup and cross-origin requirements need a concrete engine-loading contract before M0 technical completion.

## ADR-006: Evidence before compatibility promises

Public API parity means shared semantics where supported. It does not mean codec or speed parity. Pin exact engine versions/builds and preset mappings after feasibility work. Capture versioned fixtures and measurable boundary tolerances. The original four-week sequence is a planning hypothesis, not a delivery commitment.

## Decision status and outstanding evidence

| Decision | Proposed direction | Required evidence / owner |
| --- | --- | --- |
| Public API shape | Explicit client plus immutable pipelines | Approved by the project owner on 2026-09-25; consumer validation pending |
| Preset mapping | Six approved versioned definitions in presets.md | Initial native/browser encoding and decoding passed; broader quality coverage remains M5/M6 |
| Runtime matrix | Node 22/24; current/previous desktop browsers | Supported-engine/tooling checks, then execution matrix in M3/M4 |
| Native dependency setup | Caller-installed FFmpeg/FFprobe; absolute override then captured PATH | Specified in initialization.md; bounded Windows checks passed |
| Browser engine setup | Lazy default adapter with explicit same-origin assets, single-thread core | Specified in initialization.md; bounded Chrome failure/retry checks passed |
| Metadata path | Normalized probe results | Prove selected browser build supports required fields |
| Trim/resize fidelity | Accurate re-encoding, aspect-ratio-preserving fit | Define frame/sample tolerance and odd-dimension examples |
| Third-party distribution | Document actual shipped dependencies and assets | Record notices for the chosen distributions before release |

The baseline is approved; unresolved technical items remain M0 completion blockers and must not be reported as verified. M0 can proceed through drafting and focused feasibility without constructing the complete M1 workspace or implementing the SDK.


## Feasibility follow-up (2026-09-25)

Metadata and accurate re-encoded trim are feasible on the recorded Windows/native and Chrome/WASM builds. The public contract is preserved. The browser adapter needs a pinned, regression-tested probe workaround (or a verified fix), output-aware progress translation, and termination/reload cancellation. Native probing used a different FFprobe version from FFmpeg; a supported pair still needs selection. These observations do not close the broader runtime, preset or setup decisions. See [the report](./feasibility/REPORT.md).

## Preset approval (2026-09-25)

Owner approved the six-preset recommendation. Added audio-pcm-v1 to PresetId without removing existing IDs. Existing preset names now have explicit format/encoder mappings; unsupported combinations fail validation. WebM remains in the format vocabulary but has no built-in v1 preset. Preset policy changes after publication require new versioned IDs. See presets.md for measured results, timing limits and the audio-padding finding.


## Initialization configuration (2026-09-25)

Added native/browser configuration and initTimeoutMs to MavioOptions. Native auto discovery is available; browser auto selection still requires explicit application-hosted assets and does not choose a CDN. This refines the earlier no-configuration sketch; the public browser example is updated accordingly. Experimental timeout/cancellation handling now preserves the primary error before worker termination. See initialization.md and its evidence for scope limits.


## API edge-case resolution

Resolved E01-E32 under the owner's instruction to resolve the remaining API cases. Added ExecutionEngineContext.beginCommit so abort/publication races have an explicit linearization point. Added optional cleanup warnings to successful media results; an already published output is never reported as a cancelled/failed job due only to later cleanup. Clarified final encoding declarations, stream/preset restrictions, terminal validation precedence, caller-owned input stability, bounded progress and disposal behavior. See edge-cases.md. Custom engine implementations must adopt the new execution context before implementation starts; no published API migration exists yet.
