import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import { startExampleServer, stopExampleServer } from "./example-server.mjs";

async function main() {
  assert.equal(process.argv.length, 3, "Provide a prepared Browser consumer directory.");
  const consumer = resolve(process.argv[2]);
  const name = basename(consumer);
  assert.ok(["vanilla-js", "vanilla-ts"].includes(name));

  const assetDirectory = join(consumer, "public/mavio-engine");
  const manifest = JSON.parse(readFileSync(join(assetDirectory, "manifest.json"), "utf8"));

  for (const file of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
    const hash = createHash("sha256")
      .update(readFileSync(join(assetDirectory, file)))
      .digest("hex");
    assert.equal(hash, manifest.files[file], "Asset manifest mismatch: " + file);
  }

  const server = await startExampleServer(dirname(consumer), name);
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.MAVIO_BROWSER_CHANNEL ? { channel: process.env.MAVIO_BROWSER_CHANNEL } : {}),
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);
    await page.goto(server.origin);

    const result = await page.evaluate(async () => {
      const { FFmpeg } = await import("/mavio-engine/wrapper/classes.js");
      const worker = new FFmpeg();
      const messages = [];
      const collect = ({ message }) => messages.push(message);
      worker.on("log", collect);

      try {
        await worker.load({
          coreURL: new URL("/mavio-engine/ffmpeg-core.js", globalThis.location.href).href,
          wasmURL: new URL("/mavio-engine/ffmpeg-core.wasm", globalThis.location.href).href,
          classWorkerURL: new URL("/mavio-engine/wrapper/worker.js", globalThis.location.href).href,
        });

        const exitCode = await worker.exec(["-version"]);
        const versionMessages = [...messages];

        messages.length = 0;
        const demuxerExit = await worker.exec(["-demuxers"]);
        const demuxerOutput = messages.join("\n");

        messages.length = 0;
        const decoderExit = await worker.exec(["-decoders"]);
        const decoderOutput = messages.join("\n");

        return {
          exitCode,
          messages: versionMessages,
          demuxerExit,
          decoderExit,
          demuxerOutput,
          decoderOutput,
        };
      } finally {
        worker.off("log", collect);
        worker.terminate();
      }
    });

    assert.equal(result.exitCode, 0);
    const version = result.messages.find((line) => line.startsWith("ffmpeg version"));
    assert.ok(version, "No FFmpeg version was reported.");

    console.log("Chromium:", browser.version());
    console.log("Asset versions:", manifest.wrapperVersion, manifest.coreVersion);
    console.log("WASM_FFMPEG_VERSION=" + version);

    for (const line of result.messages) {
      if (/^(configuration:|libavutil|libavcodec|libavformat|libswresample)/.test(line.trim())) {
        console.log(line);
      }
    }

    assert.equal(result.demuxerExit, 0);
    assert.equal(result.decoderExit, 0);

    console.log("Affected-demuxer candidates present in engine listing:");
    for (const line of result.demuxerOutput.split(/\r?\n/)) {
      if (/^\s*D\s+(sbg|dxa|wsvqa|caf)\s/.test(line)) console.log(line);
    }

    console.log("PNM-family decoder candidates present in engine listing:");
    for (const line of result.decoderOutput.split(/\r?\n/)) {
      if (/\s(pbm|pgm|pgmyuv|ppm|pam|pfm|phm)\s/.test(line)) console.log(line);
    }

    console.log("PASS: Generated Browser core identified; worker terminated.");
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      await stopExampleServer(server);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
