import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

// Conservative dependencies for the recorded FFmpeg command dialect. Unknown
// methods fail closed; runtime divergence is never evidence of reproduction.
export function dependencies(entries) {
  const latest = new Map();
  const graph = [];
  for (const [index, entry] of entries.entries()) {
    const deps = new Set();
    const id = index + 1;
    const need = (path) => {
      for (let p = path; p !== "/"; p = posix.dirname(p)) {
        if (latest.has(p)) deps.add(latest.get(p));
      }
    };
    const { method, args } = entry;
    let writes = [];
    if (method === "exec" || method === "ffprobe") {
      const command = args[0];
      assert.ok(Array.isArray(command));
      if (method === "ffprobe")
        assert.ok(command.includes("-o"), "Expected explicit ffprobe output.");
      const output = method === "ffprobe" ? command[command.indexOf("-o") + 1] : command.at(-1);
      const paths = command.filter((arg) => typeof arg === "string" && arg.startsWith("/"));
      for (const path of paths) need(path);
      if (typeof output === "string" && output.startsWith("/")) writes = [output];
    } else {
      assert.ok(
        ["createDir", "deleteDir", "listDir", "writeFile", "readFile", "deleteFile"].includes(
          method,
        ),
        `Unsupported method: ${method}`,
      );
      const path = args[0];
      assert.ok(typeof path === "string" && path.startsWith("/"));
      need(path);
      if (method === "deleteDir" || method === "listDir") {
        for (const [child, producer] of latest) {
          if (child.startsWith(`${path}/`)) deps.add(producer);
        }
      }
      if (["createDir", "deleteDir", "writeFile", "deleteFile"].includes(method)) writes = [path];
    }
    graph.push(deps);
    // A rejected call must not become a file producer. Nonzero execs can still
    // write probe/error output, so retain them conservatively.
    if (entry.status === "fulfilled") for (const path of writes) latest.set(path, id);
  }
  return graph;
}

export function closure(ids, graph) {
  const keep = new Set(ids);
  const pending = [...keep];
  while (pending.length) {
    for (const dependency of graph[pending.pop() - 1]) {
      if (!keep.has(dependency)) {
        keep.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return [...keep].sort((a, b) => a - b);
}

export function parseResult(stdout, target) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith("MAVIO_REPLAY_RESULT "));
  try {
    const result = JSON.parse(lines.at(-1)?.slice("MAVIO_REPLAY_RESULT ".length));
    assert.ok(
      ["REPRODUCED", "NOT_REPRODUCED", "DIVERGED", "INCONCLUSIVE"].includes(result.outcome),
    );
    if (result.outcome === "REPRODUCED") {
      assert.equal(result.targetOriginalCallId, target);
      assert.equal(result.atOriginalCallId, target);
      assert.match(result.error, /memory access out of bounds/i);
    }
    return result;
  } catch {
    return { outcome: "INCONCLUSIVE", reason: "Missing or invalid final replay result." };
  }
}

async function main() {
  const tracePath = resolve(process.argv[2] ?? join(tmpdir(), "mavio-browser-regression.json"));
  const output = resolve(process.argv[3] ?? join(tmpdir(), "mavio-minimization"));
  const budget = Number(process.argv[4] ?? 100);
  assert.ok(Number.isInteger(budget) && budget > 0, "Run budget must be a positive integer.");
  const raw = await readFile(tracePath);
  const trace = JSON.parse(tracePath.endsWith(".gz") ? gunzipSync(raw) : raw);
  assert.equal(trace.schemaVersion, 1);
  const graph = dependencies(trace.entries);
  const target = trace.entries.length;
  const replay = fileURLToPath(new URL("./replay-browser-regression.mjs", import.meta.url));
  const fingerprint = createHash("sha256")
    .update(raw)
    .update(await readFile(replay))
    .update(
      await readFile(new URL("../packages/mavio/scripts/browser-assets.mjs", import.meta.url)),
    )
    .update(await readFile(fileURLToPath(import.meta.url)))
    .update(
      JSON.stringify({
        node: process.version,
        channel: process.env.MAVIO_BROWSER_CHANNEL ?? "",
        corrected: process.env.MAVIO_REPLAY_STACK_RESTORE ?? "0",
      }),
    )
    .digest("hex");
  await mkdir(output, { recursive: true });
  const checkpoint = join(output, "checkpoint.json");
  let state = { fingerprint, retained: trace.entries.map((_, i) => i + 1), trials: [] };
  try {
    state = JSON.parse(await readFile(checkpoint, "utf8"));
    assert.equal(state.fingerprint, fingerprint, "Checkpoint belongs to another trace.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let runs = 0;
  const save = async () => {
    await writeFile(checkpoint, JSON.stringify(state, null, 2));
    await writeFile(join(output, "retained.json"), JSON.stringify(state.retained));
  };
  async function trial(ids, force = false) {
    const key = ids.join(",");
    const cached = state.trials.find(
      (item) => item.key === key && item.result.outcome !== "INCONCLUSIVE",
    );
    if (cached && !force) return cached.result;
    if (runs >= budget) return null;
    runs++;
    const name = `trial-${state.trials.length + 1}`;
    const keepPath = join(output, `${name}.json`);
    await writeFile(keepPath, JSON.stringify(ids));
    const log = await new Promise((resolveLog) => {
      const child = spawn(process.execPath, [replay, tracePath, keepPath], { windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), 180_000);
      child.stdout.on("data", (data) => (stdout += data));
      child.stderr.on("data", (data) => (stderr += data));
      child.on("error", (error) => (stderr += String(error)));
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolveLog({ stdout, stderr, code, signal });
      });
    });
    let result =
      log.signal || log.code === null
        ? { outcome: "INCONCLUSIVE", reason: "Replay process interrupted." }
        : parseResult(log.stdout, target);
    const expectedExit = { REPRODUCED: 10, NOT_REPRODUCED: 0, DIVERGED: 20, INCONCLUSIVE: 30 };
    if (log.code !== expectedExit[result.outcome]) {
      result = {
        outcome: "INCONCLUSIVE",
        reason: "Process exit disagrees with structured outcome.",
      };
    }
    await writeFile(join(output, `${name}.log`), JSON.stringify(log, null, 2));
    state.trials.push({ key, retainedCallCount: ids.length, result });
    await save();
    console.log(`${name}: ${ids.length} calls: ${result.outcome}`);
    return result;
  }
  // Revalidate the current best on every invocation, including resumed runs.
  assert.equal(
    (await trial(state.retained, true))?.outcome,
    "REPRODUCED",
    "Current baseline did not reproduce; inspect logs.",
  );
  let granularity = 2;
  let exhausted = false;
  while (true) {
    const removable = state.retained.filter((id) => id !== target);
    const size = Math.max(1, Math.ceil(removable.length / granularity));
    let reduced = false;
    for (let offset = 0; offset < removable.length; offset += size) {
      const removed = new Set(removable.slice(offset, offset + size));
      const candidate = closure(
        state.retained.filter((id) => !removed.has(id)),
        graph,
      );
      if (candidate.length >= state.retained.length) continue;
      const result = await trial(candidate);
      if (!result) {
        exhausted = true;
        break;
      }
      if (result.outcome === "REPRODUCED") {
        state.retained = candidate;
        await save();
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (exhausted) break;
    if (reduced) continue;
    if (size === 1) break;
    granularity *= 2;
  }
  state.status = exhausted ? "BUDGET_EXHAUSTED" : "DEPENDENCY_CLOSED_SEARCH_COMPLETE";
  await save();
  console.log(`${state.status}: ${state.retained.length}/${target} calls; ${checkpoint}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
