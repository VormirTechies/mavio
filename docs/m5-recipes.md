# Mavio public API recipes

These examples target the private v0.0.3 package installed from the local
workspace or a package tarball. They do not assume npm publication.

## Node setup and conversion

Install FFmpeg and FFprobe separately and make them available on PATH.

Save this example as `mavio-example.mjs` in a consumer project with Mavio
installed. Run `node mavio-example.mjs input.mp4 output.mp4`.
Use a supported video input and an output path that does not already exist.

```js
import { createMavio } from "@vormir/mavio/node";

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  throw new Error("Usage: node mavio-example.mjs input.mp4 output.mp4");
}

const client = createMavio();

try {
  const source = client.from({ kind: "path", path: inputPath });

  console.log("Source metadata:", await source.metadata());

  const result = await source
    .convert({ format: "mp4", preset: "video-balanced-v1" })
    .export({ output: { kind: "path", path: outputPath } });

  console.log("Output:", result.output.path);
  console.log("Output metadata:", result.metadata);
  console.log("Cleanup warnings:", result.warnings ?? []);
} finally {
  await client.dispose();
}
```

Alternatively, configure absolute binary paths:

```js
const client = createMavio({
  native: {
    ffmpegPath: "D:/Tools/ffmpeg/bin/ffmpeg.exe",
    ffprobePath: "D:/Tools/ffmpeg/bin/ffprobe.exe",
  },
});
```

Invalid explicit paths do not fall back to PATH.
Relative media paths use the directory captured at client creation.

## Browser setup

With Mavio installed in the consuming application, run:

```sh
npm install --save-dev --save-exact @ffmpeg/core@0.12.10
npx --no-install mavio-browser-assets public/mavio-engine
```

The parent directory must exist and the destination must be new.
Host the complete generated directory on the application's HTTP(S) origin.

The generator corrects stack restoration in the pinned core JavaScript.
The WASM is unchanged. Retain the manifest and wrapper dependencies.
Unmodified upstream JavaScript is not the accepted configuration.

Use this module in a bundled browser application.
Pass a supported video File or Blob longer than 1.25 seconds:

```js
import { createMavio } from "@vormir/mavio/browser";

export async function makeClip(file, signal) {
  const client = createMavio({
    browser: {
      assets: {
        coreURL: "/mavio-engine/ffmpeg-core.js",
        wasmURL: "/mavio-engine/ffmpeg-core.wasm",
        classWorkerURL: "/mavio-engine/wrapper/worker.js",
      },
    },
  });

  try {
    const result = await client
      .from({ kind: "blob", blob: file })
      .trim({ start: 0.25, end: 1.25 })
      .resize({ width: 640, height: 360 })
      .convert({ format: "mp4", preset: "video-balanced-v1" })
      .export(
        { output: { kind: "blob" } },
        {
          signal,
          onProgress(event) {
            console.log(event.stage, event.percent);
          },
        },
      );

    return result.output.blob;
  } finally {
    await client.dispose();
  }
}
```

Supply an AbortController signal and call its abort method to request
cancellation. Cancellation before the publication gate prevents publication.
After the gate is granted, a job may still complete successfully.

The returned Blob remains usable after disposal.
Revoke application-created object URLs when no longer needed.

The initial verified deployment recipe uses these response headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Serve JavaScript and WASM with appropriate content types.
Configure CSP for the deployed worker, modules, and WASM.
Header-free deployment and other browser families need separate verification.

## Additional operations

Use these snippets inside a live client's try/finally block.
Define `source` using `client.from(input)`.
Each example submits a separate job.

MP3 extraction requires a supported audio stream:

```js
const mp3 = await source
  .extractAudio()
  .convert({ format: "mp3", preset: "audio-balanced-v1" })
  .export({ output: { kind: "bytes" } });
```

WAV extraction:

```js
const wav = await source
  .extractAudio()
  .convert({ format: "wav", preset: "audio-pcm-v1" })
  .export({ output: { kind: "bytes" } });
```

For explicit audio selection, use `extractAudio({ streamIndex })`.
The index is an absolute source stream index reported by source metadata.

Compression:

```js
const compressed = await source
  .compress({ preset: "video-small-v1" })
  .export({ format: "mp4", output: { kind: "bytes" } });
```

Thumbnails require a supported video. These examples require a duration
greater than one second:

```js
const jpeg = await source.thumbnail({
  at: 1,
  format: "jpeg",
  preset: "jpeg-balanced-v1",
  output: { kind: "bytes" },
});

const png = await source.thumbnail({
  at: 1,
  format: "png",
  preset: "png-lossless-v1",
  output: { kind: "bytes" },
});
```

## Required source profile

The current MP4 video presets require yuv420p video with explicit bt709
primaries, transfer, and color space, plus tv color range. Unknown color
metadata can cause UNSUPPORTED_CAPABILITY even when FFmpeg can decode the file.

Selected audio must have a supported 44100/48000 Hz mono or stereo profile.
See [conversion profiles](m5-conversion.md) for full restrictions.

## Behavior and limitations

- Call metadata on an untransformed source pipeline. Export and thumbnail
  results provide output metadata.
- Each trim is relative to the preceding logical clip.
- Thumbnail time is relative to the transformed clip and excludes its endpoint.
- Resize fits within the box without upscaling. MP4 dimensions round down
  to even values; inspect output metadata for actual dimensions.
- Generic export supports approved MP4, MP3, and WAV profiles.
  JPEG and PNG use the thumbnail terminal. WebM has no built-in v1 preset.
- Convert and compress must use the same preset when combined.
- Duplicate convert, compress, and extractAudio declarations are rejected.
- Thumbnail permits preceding trim and resize operations only.
- Resize after audio extraction is rejected.
- Keep caller-owned input bytes unchanged until their jobs settle.
- Do not combine an explicit custom adapter with native or browser options.
  Default entry points reject configuration for the other runtime.
- Always await client disposal. Returned bytes and Blobs remain usable.
- Handle errors using their stable code. Avoid automatically logging
  original causes, sensitive paths, or source media.
- Successful outputs can include cleanup warnings.
- Presets do not guarantee smaller output, exact file size, or identical
  bytes across engine builds. Audio decoder padding remains engine-dependent.

## Verification status

User-reported local execution on Windows x64, Node v24.22.1:

- The documented Node conversion example executed with PATH discovery.
- Native MP3, WAV, compression, JPEG, and PNG snippets executed.
- Native fractional trim and resize produced the expected dimensions.
- All seven native outputs were independently probed and decoded after disposal.
- The exact Browser makeClip example executed in Chromium 153.0.8010.12,
  bundled against the workspace SDK with generated corrected assets.
- Its Blob output survived disposal and independently passed probing and decoding.
- Browser trim, no-upscale resize, progress delivery, and rejection of an
  already-aborted signal passed.
- The existing Browser cancellation harness separately verified active encoding
  cancellation after progress, no publication, worker restart, and same-client
  recovery with 6000 exact PCM source samples.

Native tools were FFmpeg/FFprobe 9.0.2-essentials_build-www.gyan.dev.
The shared recipe fixture used explicit bt709 SDR color metadata.

These checks do not establish installed-tarball execution of the new Browser
recipe, arbitrary media support, other browsers, or fresh cross-platform CI.
See the acceptance matrix for earlier installed-package evidence.
