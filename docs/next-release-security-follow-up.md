# Required next-release security and distribution follow-up

Owner: VormirTechies project owner.
Status: required before approving the next release; target version not yet assigned.

## NR-SEC01: x264 initialization cleanup

- Review relevant upstream cleanup changes against the selected source revision.
- Investigate additional partial-initialization and allocation-failure paths.
- Add targeted regression evidence for demonstrated defects and any fixes.
- Reassess worker-discard mitigation and residual exposure.
- Record a fresh disposition; the 0.0.3 acceptance cannot be reused automatically.

## NR-LIC01: notices and distribution

- Revisit embedded-notice completeness for the actual selected runtime and libraries.
- Review opportunities to automate notice and source-delivery verification.
- Verify the public engine/source delivery arrangement and preserved modifications.
- Record a fresh distribution review for the next release.

## Required evidence

Record source revisions, findings, resolutions or explicit dispositions,
responsible reviewer, package/engine identities, and applicable verification.
Passing functional CI alone does not close either item.

These follow-ups do not authorize public publication of the current release.
