# M8 release plan

## Scope

Prepare @vormirtech/mavio 0.0.3 for public release.
Merged baseline: 336f928394ca21df502310ebece6851a71cf0c0b; PR #1.

Retain the M7-reviewed Browser and Native runtime profiles, supported
operations, limitations, and required v2 Browser engine kit.
Do not expand engine, codec, platform, or API support during release preparation.

The M7 owner dispositions apply only to this release. Mandatory follow-up
remains in next-release-security-follow-up.md.

The SDK currently remains private. Publication approval is pending.
Package metadata changes will produce a new archive identity requiring review.

## Tasks

| Task  | Deliverable                                                | Status   |
| ----- | ---------------------------------------------------------- | -------- |
| M8-01 | Release scope and merged baseline                          | Recorded |
| M8-02 | Review merged changes and reconcile release status         | Pending  |
| M8-03 | Public engine, source, notices, and CI provisioning plan   | Pending  |
| M8-04 | npm metadata and final package archive                     | Pending  |
| M8-05 | Verified developer installation and hosting instructions   | Pending  |
| M8-06 | Final release-artifact and installed-consumer validation   | Pending  |
| M8-07 | Explicit publication approval, execution, and verification | Pending  |
| M8-08 | Published release record and next-release handover         | Pending  |

## Delivery requirements

Prepare durable public delivery of the exact Browser engine together with
corresponding source, applicable notices, and modification records.
Account for the supplemental musl notice delivered by the SDK generator.
Do not publish the existing review kit unchanged without checking its final
distribution notice set and release guidance.

Replace draft-only CI provisioning with a reviewed release delivery arrangement.
Keep separately installed Native binaries outside the SDK archive.

## Launch scope

Developer installation and usage instructions are required.
A landing page, hosted documentation site, and comprehensive demo application
remain a separate launch track unless explicitly added as release requirements.

## Authorization

Release preparation is authorized. npm publication, public engine release,
production deployment, and merging the M8 branch require separate authorization.
