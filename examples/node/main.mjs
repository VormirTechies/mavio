import { createMavio } from "@vormir/mavio/node";

async function main() {
  const args = process.argv.slice(2);

  if (args.length !== 2 && args.length !== 4) {
    throw new Error(
      "Usage: npm start -- input.mp4 output.mp4 [absolute-ffmpeg-path absolute-ffprobe-path]",
    );
  }

  const [inputPath, outputPath, ffmpegPath, ffprobePath] = args;

  const client = createMavio({
    ...(args.length === 4 ? { native: { ffmpegPath, ffprobePath } } : {}),
    ...(process.env.MAVIO_EXAMPLE_DIAGNOSTICS === "1"
      ? {
          onDiagnostic(event) {
            console.info("Diagnostic:", JSON.stringify(event));
          },
        }
      : {}),
  });

  let operationFailed = false;
  let operationError;

  try {
    const source = client.from({ kind: "path", path: inputPath });
    const metadata = await source.metadata();

    console.info("Source duration:", metadata.durationSeconds ?? "unknown");

    const result = await source.convert({ format: "mp4", preset: "video-balanced-v1" }).export(
      { output: { kind: "path", path: outputPath } },
      {
        onProgress(event) {
          console.info("Progress:", event.stage, event.percent ?? "unknown");
        },
      },
    );

    console.info("Output:", result.output.path);
    console.info("Cleanup warnings:", result.warnings?.length ?? 0);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    await client.dispose();
  } catch (error) {
    if (!operationFailed) throw error;
    console.error("Client cleanup also failed; the operation error is retained.");
  }

  if (operationFailed) throw operationError;
  console.info("MAVIO_NODE_EXAMPLE_OK");
}

try {
  await main();
} catch (error) {
  console.error(error?.code ?? "EXAMPLE_FAILED", error?.message ?? "Example failed.");
  process.exitCode = 1;
}
