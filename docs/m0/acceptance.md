# M0 acceptance and validation plan

Status: M0 specification milestone complete. Owner-approved baseline, bounded feasibility and consumer type checks are recorded; production implementation and conformance remain later milestones.

## Exit checklist

- [x] Recover the agreed product direction and milestone mapping.
- [x] Draft scope, non-goals and proposed compatibility matrix.
- [x] Draft public examples and input/output contracts.
- [x] Draft engine, capability, progress and error contracts.
- [x] Specify pipeline ordering, queueing, cancellation and cleanup semantics.
- [x] Identify architecture tradeoffs and unresolved feasibility decisions.
- [x] Resolve six versioned preset definitions and their format/codec mappings; all six encoded and decoded in the bounded Windows/Chrome experiment (2026-09-25). See presets.md for limits.
- [x] Specify native discovery and browser initialization configuration; bounded path/loading/failure/retry checks and configuration types passed (2026-09-25). See initialization.md.
- [x] Validate metadata and trim feasibility for both selected engines on Windows/Chrome with the synthetic H.264/AAC fixture (2026-09-25); browser metadata requires the documented pinned-core shim.
- [x] Close API ambiguities through E01-E32 design walkthroughs in edge-cases.md; runtime conformance remains M2-M5 work.
- [x] Review typed declarations with strict TypeScript 7.0.2 and browser/Node consumer examples, including Node 22 types without DOM declarations (2026-09-25).
- [x] Obtain project-owner approval of the existing scope and contract baseline (2026-09-25).
- [x] Record final M0 release notes; the local v0.0.1 tag identifies this specification baseline under the owner's continuation instruction.

M0 is complete only after its blocking design decisions are resolved and approved. Documentation alone does not establish runtime support. M1 owns package/build/CI verification; M2 owns runnable mock-engine conformance; M3/M4 own engine integrations; M5 owns complete operation coverage.

## Scenario review matrix

| Scenario | Expected contract | First executable proof |
| --- | --- | --- |
| Browser Blob → trim → resize → MP4 Blob | Explicit preset, ordered plan, detached output | M2 mock, M4 browser |
| Node path → extract audio → audio path | Selected stream, no-clobber output | M2 mock, M3 Node |
| Source metadata | Normalized fields; unknown values omitted | M3/M4 |
| Reuse base pipeline for two exports | Independent immutable plans | M2 |
| Trim twice | Second interval relative to first output | M2/M5 |
| Missing audio / unsupported encoder | Actionable error; no silent replacement | M2/M3/M4 |
| Invalid times or conflicting presets | Reject before encoding | M2 |
| Browser path input / Node Blob output | Explicit unsupported input/output error | M2 |
| Abort queued job | Never invokes engine for that job | M2 |
| Abort running job then reuse client | Cleanup, CANCELLED, later initialization succeeds | M3/M4 |
| Abort races with publication | Exactly one terminal result; explicit beginCommit gate decides cancellation eligibility | M2/M3/M4 |
| Existing output or simultaneous writers | No overwrite; correct structured failure | M3 |
| Dispose with pending jobs | All settle; no new work accepted | M2/M3/M4 |
| Progress unavailable or callback throws | No fabricated percent; job remains correct | M2 |
| Primary failure plus cleanup failure | Preserve primary code; include cleanup diagnostics | M2/M3/M4 |
| Unknown runtime or codec | Explicit error or unresolved preflight; never assumed support | M2 |
| Install packaged SDK in JS/TS/Node consumers | Public exports/types work; browser excludes Node modules | M1, repeated M7 |

## Feasibility record template

For each selected engine record: exact package/binary/build version; OS/browser version; setup/configuration; input fixture identity and license; decoder/encoder availability; normalized metadata; trim boundary accuracy; progress availability; cancellation/restart behavior; memory observations; limitations; and resulting contract changes.

Keep fixtures small and redistributable. Do not use private user media as committed test data. Do not treat shell output or a successful engine load as proof of a completed transformation.

## Approved baseline choices

1. Use explicit `createMavio().from(input)` ownership.
2. Require an explicit output format and preset under the existing API rules.
3. Use the restricted initial stream/output policy for v0.1.

Owner approval of the baseline has been received. Later-milestone implementation and compatibility checks remain required; future owner suggestions will be assessed and incorporated with corresponding documentation and tests. No npm publication, Git tag or next-milestone approval is inferred from starting M0.


## Recorded feasibility evidence

See [metadata and trim feasibility](./feasibility/REPORT.md) for exact versions, scripts, raw results, the initial browser failure and the validated workaround. This closes the bounded feasibility and declaration-review checks, not the full runtime matrix, production engine implementation or production runtime support.
