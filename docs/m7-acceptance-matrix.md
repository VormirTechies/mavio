# M7 security and release-candidate acceptance

## Status

M7 is in progress. M7-01 baseline inventory is complete for the inspected scope.
Security acceptance, dependency assessment, licensing decisions, release-candidate
validation, and final CI remain pending.

Inventory date: 2026-10-24.
Baseline commit: 5570c7c.
M6 implementation commit bd39f209188a85ca2dc5080dc8ffff977a0b3d79 passed all
18 jobs in CI run 40019434190. That evidence does not automatically close M7.

## Task matrix

| ID    | Task                                     | Required evidence                                                                                              | Status                                                               |
| ----- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| M7-01 | Release inventory and trust boundaries   | Current package contents, dependency inventory, execution boundaries, and application responsibilities         | Inventory complete                                                   |
| M7-02 | Native execution and filesystem security | Review executable selection, arguments, protocols, staging, paths, publication, cleanup, and demonstrated gaps | Complete locally for reviewed scope                                  |
| M7-03 | Browser deployment and worker security   | Review asset URLs, generated asset integrity, worker dependencies, CSP guidance, and ownership                 | Complete locally for reviewed scope                                  |
| M7-04 | Dependency vulnerability assessment      | Applicable findings, remediation, and justified outstanding risks                                              | Open: M7-D01                                                         |
| M7-05 | Sensitive-data exposure                  | Review errors, causes, diagnostics, examples, and committed reports                                            | Complete locally for reviewed scope                                  |
| M7-06 | Licensing and redistribution             | Verified component licenses, distribution boundaries, notices, and applicable obligations                      | Open: M7-L01; notice preservation verified locally                   |
| M7-07 | Security and release policies            | Supported reporting channel, supported-version policy, and release-blocking criteria                           | Complete locally; final package check pending                        |
| M7-08 | Release-candidate package                | Reviewed metadata, version, exports, declarations, package contents, notices, and fresh consumers              | Local archive and installed consumers passed; final identity pending |
| M7-09 | Candidate acceptance                     | Required local checks and fresh CI tied to the reviewed candidate commit                                       | Standard checks passed locally; fresh CI pending                     |
| M7-10 | Final acceptance record                  | Traceable findings, resolutions, package identity, checks, CI, and limitations                                 | Pending                                                              |

## Package baseline

The current package is @vormir/mavio version 0.0.3, private, and declares MIT.
Root and package-level LICENSE files exist. No matching SECURITY, NOTICE,
COPYING, or THIRD-PARTY files appeared in the inspected root/package locations.
This is an inventory observation, not an exhaustive repository search.

Production dependency inventory:

- Direct: @ffmpeg/ffmpeg 0.12.15.
- Transitive: @ffmpeg/types 0.12.4.
- The application separately supplies @ffmpeg/core 0.12.10 for the accepted
  Browser asset-generation route.
- Native FFmpeg and FFprobe executables are installed separately.

After a successful SDK build, npm pack --dry-run --ignore-scripts reported:

| Property               | Observation                      |
| ---------------------- | -------------------------------- |
| Archive entries        | 400                              |
| Compiled dist entries  | 396                              |
| Asset CLI entries      | 1                                |
| Package root entries   | LICENSE, README.md, package.json |
| Source maps            | 132                              |
| Reported packed size   | 154481 bytes                     |
| Reported unpacked size | 807608 bytes                     |
| Bundled dependencies   | None reported                    |

The packed-file search found no WASM, executable/shared-library extensions,
ffmpeg-core.js, or node_modules entries. Dependencies remain part of the
installation and deployment review despite not being bundled in the archive.

Three sampled source maps referenced relative TypeScript paths and did not
include sourcesContent. This does not establish the contents of all 132 maps;
complete package exposure review remains M7-05/M7-08 work.

Package root, Browser, and Node exports and the asset CLI are declared.
The declared files list includes dist, scripts/browser-assets.mjs, LICENSE,
and README.md. Final candidate contents must be rechecked after release changes.

## Trust boundaries

| Boundary                                 | Inspected behavior                                                   | Remaining review                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Application to SDK                       | Typed media inputs, options, output targets, and injected adapters   | Runtime validation and hostile-input assumptions                                 |
| Application environment to Native tools  | Captured PATH directories or explicit absolute tool paths            | Tool provenance, permissions, discovery races, and deployment ownership          |
| SDK to Native processes                  | Argument arrays, shell false, ignored stdin, captured stdout/stderr  | Command construction, protocols, environment inheritance, and resource isolation |
| Media to engine parsers                  | FFmpeg/FFprobe process or Browser WASM receives media                | Parser vulnerabilities, supported profiles, and application isolation            |
| Staging to filesystem output             | Nonempty regular staged file, commit gate, non-overwriting hard link | Symlinks, races, parent ownership, filesystem constraints, and cleanup           |
| Application deployment to Browser worker | Same-origin configured asset URLs and wrapper loading                | Served bytes, dependencies, CSP, headers, and deployment integrity               |
| Worker to SDK                            | Serialized wrapper calls; cancellation terminates the worker         | Message handling, returned values, and ownership                                 |
| SDK to application observers             | Progress, structured diagnostics, results, and errors                | Sensitive fields, causes, caller logging, and observer behavior                  |

Custom adapters execute application-provided code. They require separate
trust and lifecycle review; typed adapter contracts do not provide isolation.

## Native inventory observations

Configuration captures cwd, platform, and absolute PATH search directories.
Explicit tool paths reject NUL characters and Windows .cmd/.bat wrappers.
An explicit tool selection does not fall back to PATH if that selection fails.

The process helper validates executable/cwd/arguments, copies argument arrays,
uses spawn with shell false and windowsHide true, and captures stdout/stderr
under a shared default 1048576-byte output limit.

Cancellation and output-limit handling request SIGKILL. Promise settlement
remains attached to process closure rather than assuming kill proves exit.
The helper does not itself establish a CPU, memory, filesystem, network, or
process-tree sandbox.

Publication inspects staging with lstat, requires a nonempty regular file,
and requests the commit gate before linking to the target. Link errors preserve
OUTPUT_EXISTS for EEXIST or IO_ERROR otherwise. Parent-directory integrity,
filesystem behavior, and races need task-specific review.

Source searches identified protocol_whitelist references in probe and media
command builders. Their presence does not establish complete protocol coverage
or prevention of all unintended file/network access.

## Browser inventory observations

Asset configuration requires an HTTP(S) document environment. URLs resolve
against the captured base URL and must match the page origin. Credentials,
fragments, control characters, and surrounding whitespace are rejected.

URL validation does not authenticate the bytes served at those URLs.

The asset CLI verifies pinned upstream core JavaScript and WASM hashes, checks
wrapper version 0.12.15, and patches the two native JavaScript entry points to
restore the WASM stack. It copies unchanged WASM and wrapper JavaScript modules
into a new destination and writes a manifest containing output hashes.

The inspected CLI checks wrapper version, not independent expected hashes for
each wrapper module. The manifest records generated contents; deployment-time
verification and wrapper provenance remain review items.

The worker-call helper races one operation against cancellation. Cancellation
records its outcome before termination and requires callers to discard that
worker before accepting further work. This is lifecycle handling, not proof
of worker-message security or total resource isolation.

## Application responsibilities to review

- Install and maintain trusted Native tools and control executable search paths.
- Control input/output authorization, directory permissions, and tenant boundaries.
- Host the accepted Browser assets and maintain deployment integrity and headers.
- Bound workload admission and decide application-level resource budgets.
- Treat untrusted media as parser input requiring an appropriate deployment model.
- Review logging of public errors and causes separately from structured diagnostics.
- Preserve required notices and satisfy obligations for the actual distribution.

These responsibilities do not excuse SDK defects. M7 must distinguish SDK
controls from controls the application or deployment must supply.

## Follow-up decisions

- Determine applicable security findings and add regression tests for demonstrated gaps.
- Assess all shipped source maps and package metadata for unintended exposure.
- Establish licensing and notices for dependencies and generated Browser assets.
- Review the independently installed Native-tool distribution boundary.
- Validate package version and candidate identity before release acceptance.
- Record decisions and evidence; do not infer security from passing functional CI.

M7-01 inventory does not establish vulnerability clearance, licensing compliance,
sandboxing, or release readiness. Public publication remains M8 work.

## M7-02 local verification — 2026-10-24

Reviewed Native path resolution, executable configuration/discovery, process
execution, publication, staging, and input command boundaries.

Four added publication cases passed in a 76-test focused run. They cover invalid
staging types, a destination appearing immediately before linking, and an existing
hard-link alias. Targeted lint and whitespace checks passed.

A controlled public probe demonstrated local-reference access through concat.
The project owner approved restricting default Native formats and deferring
broad metadata support.

Implemented a shared processing demuxer allowlist and a probe-only image2 route
with filename-pattern expansion disabled. Native readableContainers now reflects
the restricted metadata policy intersected with discovered demuxers.

The permanent real-engine verifier covers supported standalone fixtures,
concat rejection for path/disguised-extension/byte inputs and export, same-client
recovery, source preservation, and literal image filename behavior.
It is registered in check:native:all.

Eleven probe tests passed. An earlier Native regression run passed 409 tests;
that run preceded the final probe-only image2 refinement.

The final real-engine check:native:all run passed all seven checks:

- Tool discovery.
- Restricted input policy.
- Video processing.
- Video compression.
- Preset quality.
- Audio processing.
- Thumbnail processing.

Environment: Windows x64, Node v24.22.1, FFmpeg/FFprobe 9.0.2 essentials.

See [Native security review](m7-native-security.md) for finding M7-N01,
mitigation evidence, compatibility decisions, and residual boundaries.
Public metadata and package README guidance describe the restricted policy.

This is bounded local acceptance, not a filesystem sandbox or comprehensive
security clearance. Full final regression and cross-platform CI remain M7-09 work.

## M7-03 local verification — 2026-10-24

Reviewed Browser asset configuration/generation, initialization, installed
wrapper messaging and transfers, input staging, metadata workspace handling,
and output ownership.

All 87 focused Browser tests passed without failures or skips.
Pinned asset verification passed for wrapper 0.12.15 and core 0.12.10,
including seven wrapper JavaScript modules and expected upstream core hashes.
Five core regression tests passed. Diff whitespace checks passed.

No new Browser runtime change was required for the inspected scope.

See [Browser security review](m7-browser-security.md) for reviewed controls,
deployment responsibilities, measurement boundaries, and residual risks.

Same-origin configuration validation does not authenticate deployed content.
Runtime loading does not enforce manifest hashes. Wrapper provenance remains
part of dependency assessment. Production headers/CSP, final real-engine
acceptance, and fresh cross-platform CI are not established by these local checks.

## M7-05 local verification — 2026-10-24

Reviewed shared errors, diagnostic payloads, Native process output handling,
Browser cancellation causes, temporary workspaces, source scans, and authored
example logging. Nineteen diagnostic/process tests and 24 workspace tests passed.

All 133 current dist source maps passed the bounded inspection for absolute
references and embedded source strings. This supersedes the earlier three-map
sample for the current build; final packed-artifact verification remains M7-08.

Public errors are not automatically redacted. Native staging is unencrypted,
normal cleanup is not secure erasure, and crashes can leave temporary files.
Example CLI paths/messages are operator-visible output.

See [sensitive-data review](m7-sensitive-data.md) and
[source-map evidence](security/m7-source-map-review-2026-10-24.json).
Final package/deployment checks remain pending. M7-D01 remains open independently.

## M7-06 local evidence — 2026-10-24

SDK notice inclusion passed a package dry run. Generated assets include three
notice/guide files with verified manifest hashes. All five existing asset
regression tests passed after integration.

See [licensing review](m7-licensing.md). M7-L01 remains open for engine
source delivery and complete notices. This does not approve redistribution,
candidate adoption, or public publication.

## M7-07 local verification — 2026-10-24

GitHub private vulnerability reporting was enabled and verified.
SECURITY.md documents the reporting channel, pre-release support boundaries,
and disclosure process without an invented response SLA.
The SDK package includes a matching policy.

[Release policy](release-policy.md) defines candidate identity, required gates,
and separate M8 publication authorization. M7-D01 and M7-L01 remain open.

## M7-08 and M7-09 local evidence — 2026-10-24

The local private 0.0.3 archive contained 408 entries. Required notices and
policy files were present; all 133 packed source maps passed the recorded
checks. No prohibited bundled engine binaries or node_modules entries appeared.

A fresh consumer installed that archive. Its installed asset CLI generated
hash-verified production assets and all three notice/guide files.
All nine installed Browser modes passed. Installed Native byte metadata and
PCM export passed, preserving source bytes and output after disposal.

The full npm run check command and git diff --check passed locally.
This includes standard package verification. Fresh CI tied to a reviewed
commit remains pending.

These results concern the production core unless explicitly identified as
experimental candidate evidence. The experimental core is not adopted.
M7-D01 and M7-L01 remain open; M7 closure and M8 publication are not approved.
