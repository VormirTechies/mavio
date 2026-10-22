import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseResult } from "./minimize-browser-regression.mjs";

const replay = fileURLToPath(new URL("./replay-browser-regression.mjs", import.meta.url));
const trace = fileURLToPath(
  new URL("../testing/fixtures/browser/long-sequence.json.gz", import.meta.url),
);

for (const corrected of [false, true, true]) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [replay, trace], {
      env: { ...process.env, MAVIO_REPLAY_STACK_RESTORE: corrected ? "1" : "0" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const timer = setTimeout(() => child.kill(), 180_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (signal || code === null) reject(new Error("Regression replay interrupted."));
      else resolve({ code, stdout, stderr });
    });
  });
  const result = parseResult(output.stdout, 612);
  console.log(
    `${corrected ? "Corrected" : "Upstream"} full-trace replay: ${JSON.stringify(result)}`,
  );
  assert.equal(
    result.outcome,
    corrected ? "NOT_REPRODUCED" : "REPRODUCED",
    output.stdout + output.stderr,
  );
  assert.equal(output.code, corrected ? 0 : 10);
  assert.equal(result.retainedCallCount, 612);
  assert.equal(result.referenceSamples, 6144);
}
console.log("Regression control reproduces; both corrected 612-call replays match reference PCM.");
