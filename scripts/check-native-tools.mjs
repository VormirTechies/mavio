import process from "node:process";
import { captureNativeConfiguration } from "../packages/mavio/dist/engines/native/config.js";
import { prepareNativeTools } from "../packages/mavio/dist/engines/native/prepare.js";
import { discoverNativeInventory } from "../packages/mavio/dist/engines/native/inventory.js";

async function main() {
  const args = process.argv.slice(2);

  if (args.length !== 0 && args.length !== 2) {
    throw new Error("Provide either no arguments or two absolute paths: ffmpeg then ffprobe.");
  }

  const configuration = captureNativeConfiguration(
    args.length === 0
      ? {}
      : {
          ffmpegPath: args[0],
          ffprobePath: args[1],
        },
  );

  const controller = new AbortController();
  let deadlineExpired = false;

  // One shared deadline covers discovery, versions, and all inventory queries.
  const timer = setTimeout(() => {
    deadlineExpired = true;
    controller.abort(new Error("Native tools check exceeded 30 seconds."));
  }, 30_000);

  const context = {
    jobId: "native-tools-check",
    signal: controller.signal,
  };

  try {
    const tools = await prepareNativeTools(configuration, context);
    const inventory = await discoverNativeInventory(configuration, tools, context);

    console.log(`FFmpeg version: ${tools.ffmpeg.version}`);
    console.log(`FFprobe version: ${tools.ffprobe.version}`);

    console.table(
      Object.entries(inventory).map(([list, names]) => ({
        list,
        count: names.length,
      })),
    );

    console.log("Native tool discovery and inventory passed.");
    console.log("Media probing and processing are not covered by this check.");
  } catch (error) {
    if (deadlineExpired && error?.code === "CANCELLED") {
      throw new Error("Native tools check exceeded its 30-second deadline.", {
        cause: error,
      });
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

try {
  await main();
} catch (error) {
  console.error("Native tools check failed.");
  console.error(error instanceof Error ? error.message : "Unknown failure.");

  if (error?.code) {
    console.error(`Code: ${error.code}`);
  }

  if (error?.details) {
    console.error(JSON.stringify(error.details, null, 2));
  }

  process.exitCode = 1;
}
