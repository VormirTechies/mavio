# Runnable consumer examples

These standalone examples use an installed SDK archive, not source imports.
They are outside the repository npm workspaces. Mavio remains unpublished.

| Directory  | Example                                                                |
| ---------- | ---------------------------------------------------------------------- |
| node       | Native MP4 conversion, source metadata, progress, optional diagnostics |
| vanilla-js | Browser MP4 conversion and resize with cancellation and download       |
| vanilla-ts | The same Browser flow with strict TypeScript checking                  |
| shared     | Local static server used by both Browser examples                      |

## Prepare a package

From the SDK repository, build and create an archive in an existing directory:

```sh
npm run build
npm pack --workspace=@vormir/mavio --pack-destination <existing-directory>
```

Use the absolute path of the resulting archive in the commands below.
Copy the entire examples directory outside the SDK checkout before installing
dependencies. Keep the shared directory beside vanilla-js and vanilla-ts.

## Node

From the copied node directory:

```sh
npm install --save-exact <absolute-path-to-mavio-tarball>
npm start -- input.mp4 output.mp4
```

Install FFmpeg and FFprobe separately. They must be on PATH, or provide
absolute executable paths:

```sh
npm start -- input.mp4 output.mp4 <ffmpeg-path> <ffprobe-path>
```

The output must not already exist and its parent directory must exist.
Set MAVIO_EXAMPLE_DIAGNOSTICS=1 to observe structured diagnostic events.

## Browser JavaScript

From the copied vanilla-js directory:

```sh
npm install --save-exact <absolute-path-to-mavio-tarball>
npm run assets
npm run build
npm start
```

Open the localhost URL printed by the server. Select a supported video,
choose Create MP4, then preview or download the output.

## Browser TypeScript

From the copied vanilla-ts directory:

```sh
npm install --save-exact <absolute-path-to-mavio-tarball>
npm run assets
npm run typecheck
npm run build
npm start
```

Run the Browser servers separately, or select another port using
npm start -- 4174. Stop a server with Ctrl+C.

## Asset and source requirements

The Browser examples require the pinned Mavio v2 engine kit.
Set MAVIO_BROWSER_ENGINE_KIT before running their assets command.
The generator verifies the kit and includes its source archive and notices.
Installing the original npm core alone is insufficient; there is no silent fallback.
Kit availability and public distribution remain subject to release acceptance.

The shared server binds to 127.0.0.1 and supplies the verified COOP/COEP
headers and JavaScript/WASM content types. It is a local development server.

MP4 presets require a supported source profile, including yuv420p video
with explicit bt709 primaries, transfer and color space, tv range, and
supported mono/stereo audio when present. Browser sources also require
the documented geometry and orientation profile.

The Browser examples fit video within 640 by 360 without upscaling.
Cancel requests can still complete successfully after the publication gate.
Clients are disposed before successful download links are displayed.
Old object URLs are revoked when replaced or when the page is left.

Source restrictions are documented in [conversion profiles](../docs/m5-conversion.md).
See [diagnostics](../docs/m6-diagnostics.md) for event boundaries.

## Repository verification

With FFmpeg/FFprobe and a supported square-pixel SDR video fixture available:

```sh
npm run check:examples -- <absolute-ffmpeg-path> <absolute-ffprobe-path> <absolute-fixture-path>
```

This builds the SDK, creates a tarball, and installs it in temporary copies
of all three examples. It checks installed entry resolution, Browser asset
generation, JS/TS builds, TypeScript consumer types, Node execution, and
Browser interactions. Outputs are independently probed and decoded.

Browser checks cover invalid input, deterministic immediate cancellation,
recovery, download, worker cleanup, and output geometry. They do not replace
the separate active-encoding cancellation acceptance check.

Source example manifests and generated assets in the checkout are not
modified by this verifier. Browser execution uses Playwright Chromium,
or the channel specified by MAVIO_BROWSER_CHANNEL.

Initial component checks passed locally on Windows with Node v24.22.1,
Chromium 153.0.8010.12, and FFmpeg/FFprobe 9.0.2 essentials.
Fresh milestone CI remains pending.
