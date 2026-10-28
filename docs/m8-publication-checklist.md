# M8 publication checklist — 0.0.3

Status: publication approved and completed; public delivery verified. Handover merge pending.

## Verified preparation

- [x] M7 acceptance and release-only owner dispositions recorded.
- [x] Reviewed implementation merged through PR #1.
- [x] Release distribution assembled with source, notices, and supplemental musl notice.
- [x] Distribution archive extracted and all recorded hashes verified.
- [x] Draft upload downloaded and verified against the exact archive hash.
- [x] Local standard validation and installed-package Browser checks passed.
- [x] Initial SDK static review recorded with private guard retained; final publishable archive reviewed separately.

CI evidence: releases/m8-distribution-ci-2026-10-27.json.
Package review: releases/m8-sdk-package-review-2026-10-27.json.

## Final package preparation

- [x] Inspect and accept the recorded CI evidence for the exact candidate.
- [x] Prepare private-guard removal as an explicitly reviewed packaging change.
- [x] Build and inspect the resulting publishable SDK archive.
- [x] Record its SHA-256 and npm integrity; retain that exact archive.
- [x] Verify fresh installed consumers against the final archive.
- [x] Confirm npm account authorization for the @vormirtech scope and version availability.

## Engine publication preparation

- [x] Prepare public release title, tag, target commit, and release notes.
- [x] Identify the exact engine archive and accompanying source/notice delivery.
- [x] Review all assets that would become public; do not blindly publish the historical review draft.
- [x] Prepare stable download instructions and read-only public CI provisioning.
- [x] Obtain explicit approval for the exact public engine release.

## SDK publication preparation

- [x] Complete PR #2 review and required checks; obtain merge approval.
- [x] Verify the merged release candidate's applicability to the reviewed archive.
- [x] Obtain explicit approval for the exact npm archive and intended dist-tag.
- [x] Publish the retained reviewed archive rather than rebuilding during publication.

## Post-publication verification

- [x] Download the engine without authentication and verify its exact hash.
- [x] Confirm source archive and notices are publicly accessible.
- [x] Verify npm package version, integrity, and fresh installation.
- [x] Run installed-consumer smoke checks using public delivery.
- [x] Switch CI to public provisioning and remove draft-only write permission.
- [x] Record published URLs, support instructions, and withdrawal procedures.
- [x] Preserve mandatory next-release security and licensing follow-up.

## Boundaries

Release preparation and draft uploads do not authorize public publication.
Owner dispositions apply only to the reviewed 0.0.3 release profile.
Public delivery checks must pass before declaring the release ready for users.

## Final identity

Final publication is @vormirtech/mavio@0.0.3 following the reviewed scope migration
and PR #3. Earlier archive reviews remain historical evidence.
See m8-release-handover.md for final public identities and verification.
Public CI provisioning is verified on the handover branch; its merge remains pending.
