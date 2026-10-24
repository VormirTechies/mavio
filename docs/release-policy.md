# Release acceptance policy

## Candidate identity

Acceptance must identify the reviewed commit, package version, archive
integrity, engine builds, generated asset hashes, and applicable notices.
Evidence from an earlier commit is historical unless its applicability
to the final candidate is recorded.

## Required gates

- Document the supported runtime and media profiles and their limitations.
- Resolve release-blocking security findings or record an explicit project-owner
  decision with scope, rationale, mitigation, owner, and review date.
- Establish applicable engine licensing, complete notices, and source delivery
  before approving engine redistribution.
- Run required build, type, test, lint, formatting, and whitespace checks.
- Inspect the actual package archive, including exports, declarations, notices,
  source maps, and unintended files.
- Verify fresh installed consumers and generated assets from the packed SDK.
- Run required Native and Browser acceptance and fresh CI tied to the candidate.
- Record failures, skipped checks, and remaining limitations honestly.

Functional success does not override a security or redistribution gate.
An experimental core is not adopted by passing compatibility tests alone.

## Current open gates

M7-D01 dependency security disposition and M7-L01 engine source delivery
and notice completeness remain open. No exception is approved by this policy.

## Publication

M7 acceptance and M8 public publication are separate decisions.
Creating archives, generating assets, enabling private reporting, or recording
local acceptance does not authorize publishing npm packages, release binaries,
or production deployments.

No automatic publication is introduced by this policy.
