# M7 final disposition review

Review date: 2026-10-26.
Status: owner dispositions approved for 0.0.3 only; final candidate acceptance pending.
This record does not authorize merging or public publication.

## Exact reviewed candidate

- SDK: @vormir/mavio 0.0.3, private, MIT declaration.
- Implementation CI commit: `eec2cc95ab1fb122fb7224d38a5134549a2e5ab9`.
- CI run: https://github.com/VormirTechies/mavio/actions/runs/40230589916.
- SDK archive SHA-256: `b4bd36c1125b4ca0420eb16737bfb7b953b36697969baffd3139653776becbae`.
- Engine: `ffmpeg-5.1.10-mavio-x264-cleanup-v2`.
- Raw WASM SHA-256: `1eb120c8a57c1a09aa2ce178d23588a8ad168a0f382fb58e1116e6624786ad84`.
- Source archive SHA-256: `0dfb89431aa1a84c9acded07992724c3c112a7a8e49aac7a41072c7f633efe79`.
- CI kit archive SHA-256: `d3716527590fa75336f7e1234bb097fd1b87523b17996c052981f1dd862cb838`.

The SDK archive includes documentation changes after the implementation CI
checkpoint. It is a reviewed working-tree snapshot, not yet the final
clean-commit release archive. The draft-release target is historical metadata;
candidate identity is established by the recorded sources and hashes.

## Verified controls and checks

- Normal Browser generation requires the pinned v2 kit; no original-core fallback.
- Missing or altered kit inputs reject before destination creation.
- Existing destinations are preserved.
- Generated output includes pinned sources, collected notices, and modification records.
- The source bundle reconstructed the tested binaries.
- Its subsequent evidence-only refresh preserved all recorded build inputs.
- The reproduced x264 parameter leak passed a focused cleanup-patch sanitizer test.
- Stack controls and full 612-call replays passed.
- Fresh installed-package generation and Browser routes passed.
- All 19 required-v2 CI jobs passed, including six Browser jobs and both M6 jobs.
- Package inspection covered 413 entries and all 133 source maps.
- No engine binaries, source archives, or node_modules are bundled in the SDK archive.

## M7-D01: security disposition

Current status: OPEN pending the final recorded disposition.

The old default core has been replaced in the normal generation route.
The selected candidate has the bounded source-review, remediation, and
runtime-verification evidence linked below.

### D-R01: remaining x264 initialization-path uncertainty

The pinned source reproduced a 166-byte tracked-parameter leak on an invalid
initialization path. The local patch releases tracked parameter allocations
on failure. Native invalid and valid initialization checks passed, and the
patched WASM passed installed Browser acceptance.

Not established: exhaustive cleanup correctness for every later partial
initialization or allocation-failure path, complete CVE remediation, or
candidate-specific Browser exploitability of those untested paths.

Mitigation: SDK encoding failures reject and discard the loaded worker;
termination failures are surfaced as cleanup issues. This bounds worker
lifetime after a handled failure but does not repair every library defect.

Proposed decision: accept this narrowly described residual uncertainty for
the reviewed supported profile, while tracking upstream cleanup changes.

- Decision: PENDING; not approved by this document.
- Proposed accountable owner: VormirTechies project owner.
- Review trigger: before public publication, on relevant upstream changes,
  or on a demonstrated additional reachable failure.
- Alternative: keep M7-D01 open and investigate additional failure paths.

Broader limits: advisory review is bounded, not proof of vulnerability freedom.
Workers and Native processes do not establish complete CPU, memory, filesystem,
or process-tree isolation. Existing documented application responsibilities
remain applicable; no new sandboxing claim is introduced.

## M7-L01: licensing and source-delivery disposition

Current status: OPEN. No licensing waiver is proposed.

Verified: source/binary correspondence for the reviewed local build profile,
preserved source snapshots and modifications, collected component/runtime
license texts, and hash-verified delivery through installed asset generation.

Remaining review:

1. Confirm whether embedded per-file notices require additional prominent
   notices beyond the collected set and preserved source material.
2. Confirm the intended distribution scope: MIT SDK separately from the
   GPL-enabled Browser engine kit; no Native executables bundled by Mavio.
3. Record the resulting notice/distribution requirements and reviewer.
4. Establish and verify the public binary/source delivery arrangement during
   M8 before any public engine distribution.

The unpublished draft currently provides review storage only.
Security-risk acceptance cannot replace required license compliance.
No conclusion about every consuming application's license is made.

## Final candidate and publication controls

After the gate decisions and documentation are complete:

1. Commit the final reviewed documentation and implementation.
2. Pack and identify the final SDK archive; compare code with the tested checkpoint.
3. Record applicable CI and any checks required by subsequent changes.
4. Complete the M7 acceptance record.

PR #1 remains draft and the engine review release remains unpublished.
M8 publication requires separate explicit authorization.

## Evidence

- [Required-v2 CI](security/m7-required-v2-ci-2026-10-26.json).
- [Package inspection](security/m7-final-package-review-2026-10-26.json).
- [Installed v2 acceptance](security/m7-candidate-v2-installed-acceptance-2026-10-25.json).
- [x264 verification](security/m7-x264-param-cleanup-verification-2026-10-25.json).
- [Source reconstruction](security/m7-candidate-v2-reconstruction-2026-10-25.json).
- [Source metadata refresh](security/m7-candidate-v2-source-metadata-refresh-2026-10-25.json).
- [Exact kit contents](security/m7-candidate-v2-engine-kit-2026-10-25.json).
- [Licensing review](m7-licensing.md).
- [Dependency review](m7-dependency-security.md).

## Owner decisions — 2026-10-26

The project owner explicitly approved both proposed dispositions for
@vormir/mavio 0.0.3 and the reviewed v2 profile only.

This section supersedes the earlier PENDING decision labels. The security
residual-risk disposition is accepted for this release. The reviewed
SDK/engine distribution model is accepted subject to its stated conditions;
license obligations are not waived.

Neither approval carries forward automatically. Both subjects must be
revisited before the next release, or earlier on a recorded review trigger.

[Authoritative decision record](security/m7-owner-dispositions-2026-10-26.json).
[Next-release requirements](next-release-security-follow-up.md).

Final commit/archive identity, remaining acceptance bookkeeping, and M8 public
delivery verification remain pending. No merge or publication is authorized.
