# Long-sequence browser regression fixture

`long-sequence.json.gz` is the complete schema-version-1 trace captured from
Mavio's synthetic MP4 smoke. It contains 612 recorded FFmpeg wrapper calls,
including filesystem setup, media generation, checksum analysis, encoding,
cleanup, and the original failing AAC-to-PCM decode. Captured write bytes are
preserved so the reference decoder uses the original target input.

The trace was recorded with @ffmpeg/ffmpeg@0.12.15 and @ffmpeg/core@0.12.10.
It contains synthetic test video and a generated 440 Hz sine wave.

Run `node.exe scripts/check-browser-regression.mjs` from the workspace root.
The runner measures stack loss with bounded original-core commands, verifies
zero loss with the correction, and requires two successful corrected-core runs
with all 612 calls retained. Reduced traces, divergent replays, and inconclusive
runs cannot satisfy the regression check. The original full crash replay is
available separately through `scripts/replay-browser-regression.mjs`.
