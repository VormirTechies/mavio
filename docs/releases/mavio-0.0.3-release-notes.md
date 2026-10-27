# Mavio 0.0.3

Publication status: pending approval.

JavaScript and TypeScript multimedia SDK for Browser and Node.js applications.

## Included capabilities

- Source metadata and runtime capability discovery.
- MP4 video export, trim, resize, compression, and preset quality selection.
- Audio export, audio-track selection, and trimming.
- Thumbnail export.
- Serialized jobs, progress reporting, cancellation, disposal, and recovery.

Capabilities apply to the reviewed runtime and media profiles, not every
format or codec supported by an arbitrary FFmpeg build.

## Runtime setup

Node applications install trusted FFmpeg and FFprobe separately.
Supported Node versions are 22 and 24.

Browser applications use the separately supplied Mavio Browser engine
distribution and generate same-origin application assets with the SDK CLI.
Browser acceptance covers the tested Chromium configurations.
The original npm @ffmpeg/core package is not a fallback.

## Engine distribution

Archive: mavio-browser-engine-0.0.3.tar.gz

SHA-256:

```text
4210f97b3b37b65ca14b7ee28f3f3837f997799175be0cbf95d4568e944f0576
```

The archive includes the reviewed v2 engine kit, corresponding-source archive,
component notices, supplemental musl notice, and delivery guidance.
Use the SDK generator to apply the required JavaScript stack restoration.
Preserve generated sources, notices, and modification records with the engine.

## SDK archive

Package: @vormir/mavio@0.0.3

Reviewed archive SHA-256:

```text
1a6d1848b488daef768c1d7ad988c03d4538959659b37aad4eee84faf1b0b1fc
```

## Validation

Candidate commit: 5356b6a636644e6558071e9070bd115e6745cda4.
CI run 40450005926 passed all 19 jobs, including 12 release-distribution
consumer jobs across SDK, Browser, and example/resource checks.
The retained publishable archive passed static inspection, installed imports,
and generated-asset hash verification on Node 24.

## Known boundaries

- Native demuxers are restricted; Native execution is not a filesystem sandbox.
- Media processing may consume substantial memory and CPU.
- Public error causes may contain sensitive paths or engine information.
- Browser asset URLs do not themselves authenticate downloaded content.
- M7 owner dispositions apply only to this release; follow-up is mandatory
  before the next release.
- Mavio SDK code is MIT; media engines have separate applicable licenses.
- Acceptance is not a claim of complete vulnerability or licensing clearance.

Public download and npm installation links will be verified during publication.
