# M0 scope and compatibility

Status: scope and contract baseline approved by the project owner on 2026-09-25. Compatibility targets still require broader technical validation; all six presets passed the bounded native/browser experiment.

## Outcome

A developer can perform a documented local media task through `@vormir/mavio` without writing engine commands. The same operation semantics apply in both runtimes where the selected engine reports support. Equal codec availability, identical encoded bytes and equal performance are not promised.

## v0.1 scope

| Operation | Required behavior |
| --- | --- |
| convert | Select an explicit supported container and encoding preset. No output format is inferred from a filename. |
| compress | Use a versioned quality preset; do not promise a target size or a smaller output for every source. |
| trim | Use start-inclusive, end-exclusive times in seconds; re-encode for the documented accurate mode. |
| resize | Fit within a positive width/height box, preserve aspect ratio, do not crop or upscale. |
| extractAudio | Select one audio stream and export audio; fail clearly when absent. |
| thumbnail | Extract one still image at a specified time from the transformed video. |
| metadata | Return normalized source metadata, preserving unknown values as absent. |

Presets must be immutable definitions identified by a versioned name. Approved identifiers are `video-balanced-v1`, `video-small-v1`, `audio-balanced-v1`, `audio-pcm-v1`, `jpeg-balanced-v1` and `png-lossless-v1`. Exact mappings, compatibility rules and bounded validation are recorded in [presets](./presets.md). WebM has no built-in v1 preset and remains deferred. No production default may silently fall back to a different codec.

## Excluded

Framework adapters; Mavio Cloud; network URL inputs; arbitrary shell/FFmpeg command execution; batch processing; live media; timeline editing; exact target-byte compression; multiple source composition; multi-output jobs; public stream input/output; automatic download of native FFmpeg binaries. Future features must not be implied by the v0.1 API.

## Proposed runtime target policy

Node.js 22 and 24 on Windows, macOS and Linux are proposed validation targets, not currently verified support. Browser targets are current and previous stable desktop Chromium, Firefox and Safari at release validation; record exact tested versions in the release matrix. Mobile browsers, Electron, Bun, Deno and edge runtimes are outside the initial support promise. M0 feasibility may narrow these targets with an explicit recorded decision.

No browser or codec support claims become public until exercised against the chosen engine build. Runtime detection must fail with actionable guidance in unknown environments, rather than treating every JavaScript environment as Node.

## Input/output matrix

| Value | Browser | Node | Rules |
| --- | --- | --- | --- |
| Blob/File input | Yes | Outside initial contract | Caller retains ownership; File is accepted as Blob. |
| Uint8Array input | Yes | Yes | Caller must not mutate until the job settles; Buffer is accepted structurally. |
| Local path input | No | Yes | Resolves relative to client creation directory, not later cwd changes. |
| Blob output | Yes | No | Caller owns output and any object URLs it creates. |
| Uint8Array output | Yes | Yes | Detached from engine storage; survives client disposal. |
| Local path output | No | Yes | Existing files are rejected; parent directory must exist. |
| URL/stream input or output | No | No | Explicitly deferred, not silently buffered or fetched. |

Path output is staged beside the destination and published only after success. The Node adapter must provide a no-clobber publication strategy; inability to guarantee it must fail, not overwrite. Failed/cancelled jobs remove their own temporary artifacts, never the source or another job's files. Permissions, collisions, disk exhaustion and cleanup failures require tests.

Browser memory limits and input guidance must come from measurements in M4/M6. Do not invent a universal maximum file size. Unsupported or unsafe input must produce a structured error; no automatic cloud upload is permitted.

## Engine capability model

Capabilities describe operations, readable containers, writable container/codec combinations, accepted input/output kinds and limits for the initialized engine build. A planned operation can be supported, unsupported or unknown. Unknown is not supported: defer execution until probing resolves it, or reject with an actionable explanation.

Generic capability discovery does not guarantee a particular file will decode. Preflight combines engine capabilities, normalized source metadata and the complete plan. Corrupt input can still fail during execution.

Proposed feasibility fixtures: MP4/H.264/AAC video, WebM/VP9/Opus video, WAV/PCM audio, JPEG and PNG images. These are test candidates, not promised installed codecs. Record decoder, encoder and container availability separately for each chosen engine build.



Publication, cancellation and cleanup follow the explicit commit gate and warning rules in [edge cases](./edge-cases.md). Generic v0.1 export targets MP4/MP3/WAV; JPEG/PNG use thumbnail. WebM has no built-in v1 preset.
