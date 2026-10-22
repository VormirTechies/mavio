import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseResult } from "./minimize-browser-regression.mjs";
import { assertStackControl } from "./browser-stack-control.mjs";

const replay = fileURLToPath(new URL("./replay-browser-regression.mjs", import.meta.url));
const trace = fileURLToPath(
  new URL("../testing/fixtures/browser/long-sequence.json.gz", import.meta.url),
);

for (const { corrected, control } of [
  { corrected: false, control: true },
  { corrected: true, control: true },
  { corrected: true, control: false },
  { corrected: true, control: false },
]) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [replay, trace], {
      env: {
        ...process.env,
        MAVIO_REPLAY_STACK_RESTORE: corrected ? "1" : "0",
        MAVIO_REPLAY_STACK_CONTROL: control ? "1" : "0",
      },
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
  if (control) {
    let result;
    try {
      result = assertStackControl(output.stdout, corrected);
    } catch (error) {
      console.error(output.stdout + output.stderr);
      throw error;
    }
    assert.equal(output.code, 0, output.stdout + output.stderr);
    console.log(
      `${corrected ? "Corrected" : "Upstream"} bounded stack control: ${JSON.stringify(result)}`,
    );
    continue;
  }
  const result = parseResult(output.stdout, 612);
  console.log(
    `${corrected ? "Corrected" : "Upstream"} full-trace replay: ${JSON.stringify(result)}`,
  );
  assert.equal(result.outcome, "NOT_REPRODUCED", output.stdout + output.stderr);
  assert.equal(output.code, 0);
  assert.equal(result.targetOriginalCallId, 612);
  assert.equal(result.atOriginalCallId, 612);
  assert.equal(result.replayPosition, 612);
  assert.equal(result.retainedCallCount, 612);
  assert.equal(result.referenceSamples, 6144);
}
console.log(
  "Upstream stack loss confirmed; corrected stack is stable and both full 612-call replays match reference PCM.",
);
