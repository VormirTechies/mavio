import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { patchBrowserCore } from "../packages/mavio/scripts/browser-assets.mjs";
import { gunzipSync } from "node:zlib";
import { instrumentCoreStack } from "./browser-stack-control.mjs";

const sdkRequire = createRequire(new URL("../packages/mavio/package.json", import.meta.url));
const rootRequire = createRequire(new URL("../package.json", import.meta.url));

async function main() {
  const stackControl = process.env.MAVIO_REPLAY_STACK_CONTROL === "1";
  const tracePath = process.argv[2] ?? join(tmpdir(), "mavio-browser-regression.json");

  const traceBytes = await readFile(tracePath);
  const trace = JSON.parse(
    tracePath.endsWith(".gz")
      ? gunzipSync(traceBytes).toString("utf8")
      : traceBytes.toString("utf8"),
  );

  assert.equal(trace.schemaVersion, 1);
  assert.equal(trace.wrapperVersion, "0.12.15");
  assert.equal(trace.coreVersion, "0.12.10");
  assert.ok(Array.isArray(trace.entries));
  assert.ok(trace.entries.length > 0);

  // Original IDs always refer to positions in the complete baseline trace.
  // Optional third CLI argument: JSON file containing retained original IDs.
  const targetOriginalCallId = trace.entries.length;
  const keepPath = process.argv[3];

  const retainedCallIds = keepPath
    ? JSON.parse(await readFile(keepPath, "utf8"))
    : trace.entries.map((_, index) => index + 1);

  assert.ok(Array.isArray(retainedCallIds), "Keep file must contain an array.");
  assert.ok(retainedCallIds.length > 0, "Keep file must not be empty.");

  assert.ok(
    retainedCallIds.every((id) => Number.isInteger(id) && id >= 1 && id <= targetOriginalCallId),
    "Keep IDs must be valid original call numbers.",
  );

  assert.equal(new Set(retainedCallIds).size, retainedCallIds.length, "Keep IDs must be unique.");

  assert.ok(
    retainedCallIds.every((id, index) => index === 0 || id > retainedCallIds[index - 1]),
    "Keep IDs must remain in original order.",
  );

  assert.equal(
    retainedCallIds.at(-1),
    targetOriginalCallId,
    "The original target call must be retained.",
  );

  const wrapperDirectory = dirname(sdkRequire.resolve("@ffmpeg/ffmpeg/worker"));
  const coreDirectory = join(dirname(dirname(rootRequire.resolve("@ffmpeg/core"))), "esm");

  const assets = new Map([
    [
      "/",
      {
        type: "text/html",
        body: Buffer.from(
          '<!doctype html><link rel="icon" href="data:,">' +
            "<title>Mavio standalone regression</title>",
        ),
      },
    ],
  ]);

  for (const name of await readdir(wrapperDirectory)) {
    if (!name.endsWith(".js")) continue;

    assets.set(`/wrapper/${name}`, {
      type: "text/javascript",
      body: await readFile(join(wrapperDirectory, name)),
    });
  }

  for (const name of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
    let body = await readFile(join(coreDirectory, name));
    if (name === "ffmpeg-core.js" && process.env.MAVIO_REPLAY_STACK_RESTORE === "1") {
      body = patchBrowserCore(body);
    }
    if (name === "ffmpeg-core.js" && stackControl) body = instrumentCoreStack(body);
    assets.set(`/core/${name}`, {
      type: name.endsWith(".wasm") ? "application/wasm" : "text/javascript",
      body,
    });
  }

  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;

    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cache-Control", "no-store");

    const asset = assets.get(pathname);

    if (!asset) {
      response.writeHead(404);
      response.end();
      return;
    }

    response.setHeader("Content-Type", asset.type);
    response.end(asset.body);
  });

  let browser;
  let deadline;

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    assert.ok(address && typeof address === "object");

    const origin = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({
      headless: true,
      channel: process.env.MAVIO_BROWSER_CHANNEL || undefined,
      timeout: 60_000,
    });

    console.log(`Chromium: ${browser.version()}`);
    console.log(`Trace: ${tracePath}`);
    console.log(`Recorded calls: ${trace.entries.length}`);

    const page = await browser.newPage();
    let lastReportedOriginalCallId = null;
    let lastReportedReplayPosition = null;
    let browserCrashed = false;
    page.on("crash", () => {
      browserCrashed = true;
    });

    page.on("console", (message) => {
      if (message.text().startsWith("[replay]")) {
        const progress = /original call (\d+); replay (\d+)\//.exec(message.text());
        if (progress) {
          lastReportedOriginalCallId = Number(progress[1]);
          lastReportedReplayPosition = Number(progress[2]);
        }
        console.log(message.text());
      }
    });

    await page.goto(origin);

    const result = await Promise.race([
      page.evaluate(
        async ({ origin, trace, retainedCallIds, targetOriginalCallId, stackControl }) => {
          const { FFmpeg } = await import(`${origin}/wrapper/index.js`);

          if (stackControl) {
            const worker = new FFmpeg();
            const observations = [];
            worker.on("log", ({ message }) => {
              if (message.startsWith("MAVIO_STACK_STATE ")) {
                observations.push(JSON.parse(message.slice("MAVIO_STACK_STATE ".length)));
              }
            });
            try {
              await worker.load({
                classWorkerURL: `${origin}/wrapper/worker.js`,
                coreURL: `${origin}/core/ffmpeg-core.js`,
                wasmURL: `${origin}/core/ffmpeg-core.wasm`,
              });
              await worker.exec(["-version"]);
              await worker.ffprobe(["-version"]);
              return { mode: "STACK_CONTROL", observations };
            } finally {
              worker.terminate();
            }
          }

          function check(condition, message) {
            if (!condition) throw new Error(message);
          }

          function decode(value) {
            if (value?.__mavioTraceType === "Uint8Array") {
              return Uint8Array.from(value.bytes);
            }

            if (Array.isArray(value)) return value.map(decode);

            if (value !== null && typeof value === "object") {
              return Object.fromEntries(
                Object.entries(value).map(([key, item]) => [key, decode(item)]),
              );
            }

            return value;
          }

          const baselineEntries = decode(trace.entries).map((entry, index) => ({
            ...entry,
            originalCallId: index + 1,
          }));

          const keep = new Set(retainedCallIds);
          const entries = baselineEntries.filter((entry) => keep.has(entry.originalCallId));

          const finalEntry = baselineEntries.at(-1);
          const finalCommand = finalEntry.args[0];

          check(
            finalEntry.method === "exec" &&
              finalEntry.status === "rejected" &&
              Array.isArray(finalCommand) &&
              /memory access out of bounds/i.test(finalEntry.error),
            "Trace must end at the recorded EXEC memory trap.",
          );

          check(
            finalCommand.includes("pcm_s16le") && finalCommand.includes("s16le"),
            "Expected the recorded PCM decode command.",
          );

          const inputIndex = finalCommand.indexOf("-i");
          check(inputIndex >= 0, "Final command has no input.");

          const inputPath = finalCommand[inputIndex + 1];
          const outputPath = finalCommand.at(-1);

          const capturedWrite = [...baselineEntries]
            .reverse()
            .find(
              (entry) =>
                entry.method === "writeFile" &&
                entry.status === "fulfilled" &&
                entry.args[0] === inputPath,
            );

          check(
            capturedWrite?.args[1] instanceof Uint8Array,
            "Recorded final input bytes are missing.",
          );

          const assets = {
            classWorkerURL: `${origin}/wrapper/worker.js`,
            coreURL: `${origin}/core/ffmpeg-core.js`,
            wasmURL: `${origin}/core/ffmpeg-core.wasm`,
          };

          // Independent reference using the same file and decode options.
          const referenceWorker = new FFmpeg();
          let reference;

          try {
            await referenceWorker.load(assets);
            await referenceWorker.writeFile(
              "/reference.mp4",
              new Uint8Array(capturedWrite.args[1]),
            );

            const command = [...finalCommand];
            command[inputIndex + 1] = "/reference.mp4";
            command[command.length - 1] = "/reference.pcm";

            check(
              (await referenceWorker.exec(command)) === 0,
              "Fresh-worker reference decode failed.",
            );

            reference = new Uint8Array(await referenceWorker.readFile("/reference.pcm"));

            check(
              reference.length > 0 && reference.length % 2 === 0,
              "Reference PCM is empty or malformed.",
            );
          } finally {
            referenceWorker.terminate();
          }

          const allowedMethods = new Set([
            "createDir",
            "deleteDir",
            "listDir",
            "writeFile",
            "readFile",
            "deleteFile",
            "exec",
            "ffprobe",
          ]);

          const worker = new FFmpeg();

          let loaded = false;
          let atOriginalCallId = null;
          let replayPosition = null;

          function describeError(error) {
            return error instanceof Error ? error.message : String(error);
          }

          function replayResult(outcome, reason, extra = {}) {
            return {
              outcome,
              targetOriginalCallId,
              atOriginalCallId,
              replayPosition,
              retainedCallCount: entries.length,
              referenceSamples: reference.length / 2,
              reason,
              ...extra,
            };
          }

          try {
            await worker.load(assets);
            loaded = true;

            for (const [index, entry] of entries.entries()) {
              atOriginalCallId = entry.originalCallId;
              replayPosition = index + 1;

              const isTarget = entry.originalCallId === targetOriginalCallId;
              const phase =
                `original call ${entry.originalCallId}; ` +
                `replay ${index + 1}/${entries.length}: ${entry.method}`;

              check(allowedMethods.has(entry.method), `Unsupported trace method at ${phase}`);

              if (index % 50 === 0 || isTarget) {
                console.log(`[replay] ${phase}`);
              }

              let actual;

              try {
                actual = await worker[entry.method](...structuredClone(entry.args));
              } catch (error) {
                const message = String(error);

                if (isTarget) {
                  if (/memory access out of bounds/i.test(message)) {
                    return replayResult(
                      "REPRODUCED",
                      "Target decode rejected with the matching memory trap.",
                      { error: message },
                    );
                  }

                  return replayResult(
                    "DIVERGED",
                    "Target decode rejected with a different error.",
                    { error: message },
                  );
                }

                if (
                  entry.status === "rejected" &&
                  typeof entry.error === "string" &&
                  message.split("\n")[0] === entry.error.split("\n")[0]
                ) {
                  continue;
                }

                return replayResult("DIVERGED", `Unexpected rejection at ${phase}`, {
                  error: message,
                });
              }

              if (isTarget) {
                if (actual !== 0) {
                  return replayResult("DIVERGED", "Target decode returned a nonzero exit code.", {
                    actualExitCode: actual,
                  });
                }

                const pcm = await worker.readFile(outputPath);

                const matchesReference =
                  pcm instanceof Uint8Array &&
                  pcm.length === reference.length &&
                  pcm.every((value, offset) => value === reference[offset]);

                if (!matchesReference) {
                  return replayResult(
                    "DIVERGED",
                    "Target PCM differs from the fixed baseline reference.",
                  );
                }

                return replayResult(
                  "NOT_REPRODUCED",
                  "Target decode succeeded and PCM matches the fixed reference.",
                );
              }

              check(entry.status === "fulfilled", `Expected rejection was missing at ${phase}`);

              if (entry.method === "exec" || entry.method === "ffprobe") {
                check(actual === entry.exitCode, `Exit code diverged at ${phase}`);
              }
            }

            return replayResult("DIVERGED", "Replay ended without reaching the original target.");
          } catch (error) {
            return replayResult(loaded ? "DIVERGED" : "INCONCLUSIVE", describeError(error));
          } finally {
            worker.terminate();
          }
        },
        { origin, trace, retainedCallIds, targetOriginalCallId, stackControl },
      ),
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Standalone replay exceeded 120 seconds.")),
          120_000,
        );
      }),
    ]).catch((error) => ({
      outcome: "INCONCLUSIVE",
      targetOriginalCallId,
      atOriginalCallId: null,
      replayPosition: null,
      retainedCallCount: retainedCallIds.length,
      lastReportedOriginalCallId,
      lastReportedReplayPosition,
      browserCrashed,
      reason: error instanceof Error ? error.message : String(error),
    }));

    console.table(result);

    if (result.mode === "STACK_CONTROL") {
      console.log(`MAVIO_STACK_CONTROL_RESULT ${JSON.stringify(result)}`);
      return;
    }

    // The minimizer must parse this exact prefix and inspect outcome.
    // Process exit status alone is not a reproduction oracle.
    console.log(`MAVIO_REPLAY_RESULT ${JSON.stringify(result)}`);

    const exitCodes = {
      NOT_REPRODUCED: 0,
      REPRODUCED: 10,
      DIVERGED: 20,
      INCONCLUSIVE: 30,
    };

    process.exitCode = exitCodes[result.outcome] ?? 30;
  } finally {
    clearTimeout(deadline);

    try {
      if (browser) await browser.close();
    } finally {
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
          server.closeAllConnections();
        });
      }
    }
  }
}

try {
  await main();
} catch (error) {
  console.error("Standalone browser replay failed.");
  console.error(error);

  // Startup, invalid selection, or cleanup errors invalidate this run.
  // If an earlier result was emitted, consumers must use this last result.
  console.log(
    `MAVIO_REPLAY_RESULT ${JSON.stringify({
      outcome: "INCONCLUSIVE",
      reason: error instanceof Error ? error.message : String(error),
    })}`,
  );

  process.exitCode = 30;
}
