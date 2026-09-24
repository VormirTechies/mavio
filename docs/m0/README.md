# Mavio M0 — discovery and contracts

Status: **M0 complete — v0.0.1 specification milestone; bounded validation recorded; SDK implementation pending**
Milestone version: **v0.0.1**
Prepared: 2026-09-25

Mavio is a universal JavaScript multimedia SDK. Developers express media intent; engines implement execution. The public package is planned as `@vormir/mavio`.

This baseline records the approved product decisions and contracts. It does not introduce an SDK implementation, package tooling, installed engines, or an npm publication.

## Read in order

1. [Scope and compatibility](./scope.md)
2. [Public API and behavior](./api.md)
3. [TypeScript contract draft](./contracts.ts)
4. [Architecture decisions](./decisions.md)
5. [Acceptance and validation plan](./acceptance.md)

## Already agreed

- Vanilla JavaScript, TypeScript, browser and Node.js first.
- Browser uses ffmpeg.wasm initially; Node uses native FFmpeg initially.
- Seven essential operations: convert, compress, trim, resize, extract audio, thumbnail and metadata.
- Framework adapters follow v0.1 core stability. Cloud and AI processing are outside v0.1.
- Keep the core SDK open source and local processing useful independently of future cloud services.
- One monorepo for the SDK, docs, playground, examples and shared fixtures; only the SDK is published.
- M0–M8 map to v0.0.1–v0.0.9; the validated foundation is promoted to v0.1.0.

## Approved contract baseline

An explicit client owns an engine and its jobs. Immutable pipelines execute only through a terminal method. Cancellation uses AbortSignal, progress can be indeterminate, engine selection never uploads media, and capability checks describe the actual installed engine.

These details refine the earlier conceptual `mavio(input)...export(output)` sketch. The sketch was not a frozen API. See the decisions document for tradeoffs.

## Milestone status

Scope, API, contract, lifecycle, capability model and validation plan are drafted. The project owner approved the existing contract on 2026-09-25. Metadata/trim feasibility passed for the recorded Windows/Chrome fixture, and strict browser/Node contract consumer checks passed. The six approved preset definitions and initial native/browser checks are complete. Engine configuration is specified and bounded initialization checks passed. API edge cases are resolved in 32 design walkthroughs. Broader platform and runtime conformance remain later implementation work. See [v0.0.1 release notes](./RELEASE-NOTES.md) for milestone delivery and limits.

M1 establishes the monorepo/build/test/CI foundation. M2 implements the core against a mock engine. M3 and M4 prove native and browser execution with metadata and one trim path; M5 completes all seven operations and their shared conformance tests.

## Contract evolution

The owner has authorized proceeding with this baseline and expects to suggest changes during development. For each suggestion, assess feasibility, runtime parity, lifecycle/resource behavior, compatibility and affected consumers. Incorporate valid changes into the contracts, architecture decisions, implementation, examples and relevant tests together. Explain conflicts or tradeoffs before applying a suggestion that cannot preserve the intended behavior. Record the reason and compatibility impact of each accepted revision. Approval of this baseline does not assert that outstanding technical checks have passed.


## Feasibility results

[Metadata and trim feasibility report](./feasibility/REPORT.md) records the 2026-09-25 native/browser proof and its limits. No production SDK or universal runtime support is implied.


## Approved presets

[Six v1 presets](./presets.md) define the encoding baseline and record the 2026-09-25 comparison. Audio PCM is now included; WebM presets remain deferred.


## Engine setup

[Native discovery and browser initialization](./initialization.md) defines explicit configuration, lazy loading, deadlines and failure/retry handling. Implementation remains assigned to M3/M4.


## Edge-case resolution

[32 scenario decisions](./edge-cases.md) close the remaining API ambiguities. The engine contract adds beginCommit and successful media results can carry post-publication cleanup warnings. These requirements await implementation and conformance tests in subsequent milestones.
