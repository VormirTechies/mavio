# Browser engine setup — SDK 0.0.3

## Availability

The distribution is locally verified. Public download and npm publication
are pending. These instructions describe the prepared release artifacts;
they do not claim that a public download is available.

Archive: mavio-browser-engine-0.0.3.tar.gz

SHA-256:

```text
4210f97b3b37b65ca14b7ee28f3f3837f997799175be0cbf95d4568e944f0576
```

## Verify and extract on Windows

Use the approved release download when its URL has been published and verified.
Until then, use the locally reviewed archive.
Run the following from the directory containing the archive:

```powershell
$archive = (Resolve-Path "mavio-browser-engine-0.0.3.tar.gz").Path
$expected = "4210f97b3b37b65ca14b7ee28f3f3837f997799175be0cbf95d4568e944f0576"
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw "Engine archive hash mismatch."
}
$destination = Join-Path (Get-Location) "mavio-browser-engine-0.0.3"
if (Test-Path -LiteralPath $destination) { throw "Choose a new extraction directory." }
New-Item -ItemType Directory -Path $destination | Out-Null
& "$env:SystemRoot\System32\tar.exe" -xzf "$archive" -C "$destination"
if ($LASTEXITCODE -ne 0) { throw "Extraction failed." }
$env:MAVIO_BROWSER_ENGINE_KIT = Join-Path $destination "engine-kit"
```

## Generate application assets

Install the released SDK once available, or use the reviewed SDK archive
during release preparation. Run the following in the application directory
with the SDK installed locally and MAVIO_BROWSER_ENGINE_KIT set:

```powershell
New-Item -ItemType Directory -Path public -Force | Out-Null
npx --no-install mavio-browser-assets public/mavio-engine
if ($LASTEXITCODE -ne 0) { throw "Asset generation failed." }
```

The output directory must not already exist. The generator verifies the
pinned kit, applies JavaScript stack restoration, and preserves the unchanged
reviewed WASM. Do not deploy raw engine-kit/core files directly.

## Host and configure

Serve the generated directory from the application's origin. Preserve all
generated files, including wrapper modules, notices, source archive,
modification records, licensing guide, and manifest.

Configure the Browser client:

```js
import { createMavio } from "@vormir/mavio/browser";

const client = createMavio({
  browser: {
    assets: {
      coreURL: "/mavio-engine/ffmpeg-core.js",
      wasmURL: "/mavio-engine/ffmpeg-core.wasm",
      classWorkerURL: "/mavio-engine/wrapper/worker.js",
    },
  },
});

// Await client.dispose() when finished with the client.
```

Serve JavaScript and WASM with appropriate content types. Asset requests
must return the actual files rather than an application HTML fallback.
Ensure hosting rules allow workers and access to the source and notice files.

The generated hash manifest supports deployment verification; configuring
asset URLs does not itself authenticate the content served at those URLs.

## Distribution boundary

The SDK generator supplies the supplemental musl notice as well as wrapper
notices. The archive also preserves that supplemental notice separately.
Keep these materials with any engine distribution or hosted deployment.

M7 acceptance is limited to the reviewed SDK 0.0.3 profile and owner
dispositions. It is not a blanket licensing or vulnerability certification.
Public delivery and publication require the remaining M8 checks.

## Troubleshooting

- Missing kit: select the extracted engine-kit subdirectory.
- Hash mismatch: stop and obtain the exact reviewed distribution.
- Existing output: choose a new destination rather than overwriting files.
- Worker or WASM load failure: check URLs, response bodies, content types,
  and application hosting policies.
- Installing the original @ffmpeg/core package does not replace the required kit.
