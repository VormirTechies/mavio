# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through:
https://github.com/VormirTechies/mavio/security/advisories/new

Private vulnerability reporting was verified as enabled on 2026-10-24.
Do not post sensitive media, credentials, personal data, or exploit details
in public issues. Use synthetic or minimized samples where possible.

Include the SDK version or commit, runtime, OS/browser, engine version and
asset hashes when available, reproduction steps, observed impact, and any
workaround. Remove unrelated sensitive information from logs and samples.

Report SDK, asset-generation, lifecycle, and integration concerns here.
Underlying FFmpeg or other dependency issues may require coordinated
upstream reporting. Include enough build information to distinguish them.

## Supported versions

Mavio is currently pre-release. Version 0.0.3 is the current private
development package; it is not a production security-support commitment.

Reports against the current development branch and current candidate are
reviewed. Older snapshots have no guaranteed backport support. A released
support window must be declared explicitly before a stable release.

Native tools are installed separately. Applications must maintain their
actual binaries and deployments. Browser core and wrapper versions must be
identified separately from the SDK version.

## Response and disclosure

Maintainers will assess reports and coordinate remediation and disclosure.
No fixed response deadline or remediation SLA is currently promised.
Submitting a report does not require public disclosure of a user's media.

Please coordinate publication of vulnerability details with maintainers.
Acknowledge contributors only with their consent.

## Security boundaries

Untrusted media is parser input. Native processes are not an OS sandbox.
Browser workers and WASM do not establish complete resource isolation.

Diagnostic events expose selected fields, while public errors retain
underlying causes and are not automatically redacted. Temporary media
cleanup is not secure erasure, and crashes may leave files behind.

Passing functional tests or npm audits does not establish vulnerability
freedom. Consult the repository's M7 findings and acceptance records for
the reviewed scope and unresolved gates.
