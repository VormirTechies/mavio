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
    name: "Long-sequence stack regression (control and corrected)",
    script: "check-browser-regression.mjs",
  },
  {
    name: "Public MP4 trim, exports and recovery",
    script: "check-browser-client.mjs",
    mode: "mp4-public",
  },
  {
    name: "MP4 resize preparation",
    script: "check-browser-client.mjs",
    mode: "resize",
  },
  {
    name: "Public MP4 resize and combined trim",
    script: "check-browser-client.mjs",
    mode: "resize-public",
  },
  {
    name: "Public MP4 compression and controlled size comparison",
    script: "check-browser-client.mjs",
    mode: "compression-public",
  },
  {
    name: "Public preset quality on landscape and portrait fixtures",
    script: "check-browser-client.mjs",
    mode: "preset-quality-public",
  },
  {
    name: "Public audio exports and recovery",
    script: "check-browser-client.mjs",
    mode: "audio-public",
  },
  {
    name: "Public multi-track audio selection and recovery",
    script: "check-browser-client.mjs",
    mode: "audio-selection-public",
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
      gate: "Long-sequence WASM stack regression",
      status: "passed with corrected core assets",
    },
    {
      gate: "Public MP4 video trim acceptance",
      status: "passed",
    },
    {
      gate: "Installed-package public browser routes",
      status: process.env.MAVIO_BROWSER_CONSUMER_DIR ? "passed" : "not exercised",
    },
    {
      gate: "Final browser validation documentation",
      status: "see docs/m4-browser-validation.md",
    },
  ]);

  console.log("Cross-platform release acceptance requires a fresh complete CI matrix.");

  console.log("Browser acceptance requires generated core assets; upstream core remains affected.");
}

try {
  await main();
} catch (error) {
  console.error("Browser route verification failed.");
  console.error(error);
  process.exitCode = 1;
}
