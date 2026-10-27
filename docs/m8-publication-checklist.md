# M8 publication checklist — 0.0.3

Status: release preparation; publication is not authorized.

## Verified preparation

- [x] M7 acceptance and release-only owner dispositions recorded.
- [x] Reviewed implementation merged through PR #1.
- [x] Release distribution assembled with source, notices, and supplemental musl notice.
- [x] Distribution archive extracted and all recorded hashes verified.
- [x] Draft upload downloaded and verified against the exact archive hash.
- [x] Local standard validation and installed-package Browser checks passed.
- [x] SDK static package review recorded; private guard retained.

CI evidence: releases/m8-distribution-ci-2026-10-27.json.
Package review: releases/m8-sdk-package-review-2026-10-27.json.

## Final package preparation

- [ ] Inspect and accept the recorded CI evidence for the exact candidate.
- [ ] Prepare private-guard removal as an explicitly reviewed packaging change.
- [ ] Build and inspect the resulting publishable SDK archive.
- [ ] Record its SHA-256 and npm integrity; retain that exact archive.
- [ ] Verify fresh installed consumers against the final archive.
- [ ] Confirm npm account authorization for the @vormir scope and version availability.

## Engine publication preparation

- [ ] Prepare public release title, tag, target commit, and release notes.
- [ ] Identify the exact engine archive and accompanying source/notice delivery.
- [ ] Review all assets that would become public; do not blindly publish the historical review draft.
- [ ] Prepare stable download instructions and read-only public CI provisioning.
- [ ] Obtain explicit approval for the exact public engine release.

## SDK publication preparation

- [ ] Complete PR #2 review and required checks; obtain merge approval.
- [ ] Verify the merged release candidate's applicability to the reviewed archive.
- [ ] Obtain explicit approval for the exact npm archive and intended dist-tag.
- [ ] Publish the retained reviewed archive rather than rebuilding during publication.

## Post-publication verification

- [ ] Download the engine without authentication and verify its exact hash.
- [ ] Confirm source archive and notices are publicly accessible.
- [ ] Verify npm package version, integrity, and fresh installation.
- [ ] Run installed-consumer smoke checks using public delivery.
- [ ] Switch CI to public provisioning and remove draft-only write permission.
- [ ] Record published URLs, support instructions, and withdrawal procedures.
- [ ] Preserve mandatory next-release security and licensing follow-up.

## Boundaries

Release preparation and draft uploads do not authorize public publication.
Owner dispositions apply only to the reviewed 0.0.3 release profile.
Public delivery checks must pass before declaring the release ready for users.
