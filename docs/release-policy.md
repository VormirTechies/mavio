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

## Current release dispositions

For the reviewed 0.0.3/v2 profile, the owner approved the documented
security residual-risk disposition and candidate distribution model.
See docs/security/m7-owner-dispositions-2026-10-26.json.

These decisions apply to this release only and do not carry forward.
License obligations remain in force. Public binary/source delivery must
be verified during M8 before distribution.

Final committed package identity, final validation, and the M7 acceptance
record remain pending. No merge or publication approval is implied.

## Publication

M7 acceptance and M8 public publication are separate decisions.
Creating archives, generating assets, enabling private reporting, or recording
local acceptance does not authorize publishing npm packages, release binaries,
or production deployments.

No automatic publication is introduced by this policy.
