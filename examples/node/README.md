# Node consumer example

This standalone example consumes an installed Mavio package.
It is not part of the repository's npm workspaces.

Copy this directory to a separate consumer directory, then install the
local SDK tarball there:

```sh
npm install --save-exact <absolute-path-to-mavio-tarball>
npm start -- input.mp4 output.mp4
```

Install FFmpeg and FFprobe separately. Put them on PATH or supply
their absolute executable paths as the third and fourth arguments:

```sh
npm start -- input.mp4 output.mp4 <ffmpeg-path> <ffprobe-path>
```

Use an output path that does not already exist. Parent directories must
exist. Relative media paths use the directory captured at client creation.

The MP4 preset requires a supported source profile, including yuv420p
video with explicit bt709 primaries, transfer, and color space, tv range,
and supported mono/stereo audio when present.

Set MAVIO_EXAMPLE_DIAGNOSTICS=1 to print structured diagnostic events.
Original errors and causes are not automatically dumped by this example.

The client is disposed on success and failure. An operation error is
retained if client disposal also fails.

Mavio remains private/unpublished; these instructions use a local tarball.
