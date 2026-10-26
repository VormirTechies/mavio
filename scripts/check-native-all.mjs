import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const checks = [
  ["Tool discovery", "check-native-tools.mjs"],
  ["Restricted input policy", "check-native-input-policy.mjs"],
  ["Video processing", "check-native-media.mjs"],
  ["Video compression", "check-native-compression.mjs"],
  ["Preset quality", "check-native-preset-quality.mjs"],
  ["Audio processing", "check-native-audio.mjs"],
  ["Thumbnail processing", "check-native-thumbnail.mjs"],
];

function run(script, args) {
  const scriptPath = fileURLToPath(new URL(script, import.meta.url));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });

    child.once("error", reject);

    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve();
      } else {
        reject(new Error(`${script} failed: exit=${String(code)}, signal=${String(signal)}.`));
      }
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  if ((args.length !== 0 && args.length !== 2) || args.some((path) => !isAbsolute(path))) {
    throw new Error("Provide no arguments or absolute FFmpeg and FFprobe paths.");
  }

  console.log(`Native acceptance: Node ${process.version}, ${process.platform}/${process.arch}`);

  const results = [];

  // Run sequentially so checks do not compete for encoding resources.
  for (const [name, script] of checks) {
    console.log(`\nStarting: ${name}`);
    const started = Date.now();

    await run(script, args);

    results.push({
      check: name,
      status: "passed",
      seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
    });
  }

  console.table(results);
  console.log("All native acceptance checks passed.");
}

try {
  await main();
} catch (error) {
  console.error("Native acceptance failed.");
  console.error(error);
  process.exitCode = 1;
}
