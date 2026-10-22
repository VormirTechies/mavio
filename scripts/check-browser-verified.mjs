import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const checks = [
  {
    name: "Pinned engine assets",
    script: "check-browser-engine-assets.mjs",
  },
  {
    name: "MP4 resize preparation",
    script: "check-browser-client.mjs",
    mode: "resize",
  },
  {
    name: "Public audio exports and recovery",
    script: "check-browser-client.mjs",
    mode: "audio-public",
  },
  {
    name: "Public audio trim and recovery",
    script: "check-browser-client.mjs",
    mode: "audio-trim-public",
  },
  {
    name: "Public thumbnails and recovery",
    script: "check-browser-client.mjs",
    mode: "thumbnail-public",
  },
  {
    name: "Active encoding cancellation",
    script: "check-browser-client.mjs",
    mode: "cancellation",
  },
];

function run({ script, mode }) {
  const scriptPath = fileURLToPath(new URL(script, import.meta.url));
  const environment = { ...process.env };

  if (mode === undefined) {
    delete environment.MAVIO_BROWSER_SMOKE;
  } else {
    environment.MAVIO_BROWSER_SMOKE = mode;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: root,
      env: environment,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });

    child.once("error", reject);

    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve();
      } else {
        reject(
          new Error(
            `${script} (${mode ?? "assets"}) failed: ` +
              `exit=${String(code)}, signal=${String(signal)}.`,
          ),
        );
      }
    });
  });
}

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("This verification runner accepts no arguments.");
  }

  console.log(
    `Browser route verification: Node ${process.version}, ` + `${process.platform}/${process.arch}`,
  );

  console.log(`Browser channel: ${process.env.MAVIO_BROWSER_CHANNEL || "Playwright Chromium"}`);

  const results = [];

  // Separate processes keep focused checks independent.
  // Run sequentially to avoid competing for browser/WASM resources.
  for (const entry of checks) {
    console.log(`\nStarting: ${entry.name}`);
    const started = Date.now();

    try {
      await run(entry);

      results.push({
        check: entry.name,
        status: "passed",
        seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
      });
    } catch (cause) {
      results.push({
        check: entry.name,
        status: "failed",
        seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
      });

      console.table(results);

      throw new Error(`Browser route verification stopped at: ${entry.name}.`, { cause });
    }
  }

  console.table(results);
  console.log("All checks in the verified browser route suite passed.");

  console.table([
    {
      gate: "Long-sequence WASM allocator regression",
      status: "open",
    },
    {
      gate: "Public MP4 video trim acceptance",
      status: "pending",
    },
    {
      gate: "Final compatibility, packaged consumer and documentation checks",
      status: "pending",
    },
  ]);

  console.log("M4 acceptance remains incomplete until its remaining gates close.");
}

try {
  await main();
} catch (error) {
  console.error("Browser route verification failed.");
  console.error(error);
  process.exitCode = 1;
}
