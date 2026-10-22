import assert from "node:assert/strict";
import test from "node:test";
import { closure, dependencies, parseResult } from "./minimize-browser-regression.mjs";

test("retains producers, directory setup, and deletion before path reuse", () => {
  const call = (method, args) => ({ method, args, status: "fulfilled" });
  const graph = dependencies([
    call("createDir", ["/job"]),
    call("writeFile", ["/job/in", {}]),
    call("exec", [["-i", "/job/in", "/job/out"]]),
    call("readFile", ["/job/out"]),
    call("deleteFile", ["/job/out"]),
    call("exec", [["-i", "/job/in", "/job/out"]]),
  ]);
  assert.deepEqual(closure([4], graph), [1, 2, 3, 4]);
  assert.deepEqual(closure([6], graph), [1, 2, 3, 5, 6]);
});

test("read-only checksum calls can be removed independently", () => {
  const graph = dependencies([
    { method: "writeFile", args: ["/in", {}], status: "fulfilled" },
    { method: "exec", args: [["-i", "/in", "pipe:1"]], status: "fulfilled" },
    { method: "exec", args: [["-i", "/in", "/out"]], status: "rejected" },
  ]);
  assert.deepEqual(closure([3], graph), [1, 3]);
});

test("uses the last structured outcome and rejects wrong-target traps", () => {
  const line = (value) => `MAVIO_REPLAY_RESULT ${JSON.stringify(value)}\n`;
  const trap = {
    outcome: "REPRODUCED",
    atOriginalCallId: 612,
    targetOriginalCallId: 612,
    error: "memory access out of bounds",
  };
  assert.equal(parseResult(line(trap), 612).outcome, "REPRODUCED");
  assert.equal(parseResult(line(trap), 611).outcome, "INCONCLUSIVE");
  assert.equal(parseResult(line(trap) + line({ outcome: "DIVERGED" }), 612).outcome, "DIVERGED");
  assert.equal(parseResult("", 612).outcome, "INCONCLUSIVE");
  assert.equal(
    parseResult(line(trap) + line({ outcome: "INCONCLUSIVE" }), 612).outcome,
    "INCONCLUSIVE",
  );
});
