import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";

const sdkRequire = createRequire(new URL("../packages/mavio/package.json", import.meta.url));
const rootRequire = createRequire(new URL("../package.json", import.meta.url));

async function packageRoot(name, resolver) {
  let directory = dirname(resolver.resolve(name));

  while (true) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));

      if (metadata.name === name) {
        return { directory, metadata };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const parent = dirname(directory);

    if (parent === directory) {
      throw new Error(`Could not locate the package root for ${name}.`);
    }

    directory = parent;
  }
}

async function checkFile(path) {
  const info = await stat(path);

  assert.ok(info.isFile(), `Expected a regular file: ${path}`);
  assert.ok(info.size > 0, `Empty asset: ${path}`);

  const bytes = await readFile(path);

  return {
    bytes,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function main() {
  const wrapper = await packageRoot("@ffmpeg/ffmpeg", sdkRequire);
  const core = await packageRoot("@ffmpeg/core", rootRequire);

  assert.equal(wrapper.metadata.version, "0.12.15");
  assert.equal(core.metadata.version, "0.12.10");

  const wrapperDirectory = join(wrapper.directory, "dist", "esm");
  const coreDirectory = join(core.directory, "dist", "esm");

  const files = await readdir(wrapperDirectory);

  for (const required of ["index.js", "classes.js", "worker.js"]) {
    assert.ok(files.includes(required), `Missing wrapper module: ${required}`);
    await checkFile(join(wrapperDirectory, required));
  }

  // Verify all shipped ESM JavaScript files, including worker dependencies.
  const wrapperModules = files.filter((name) => name.endsWith(".js"));

  for (const name of wrapperModules) {
    await checkFile(join(wrapperDirectory, name));
  }

  const coreJavaScript = await checkFile(join(coreDirectory, "ffmpeg-core.js"));
  const coreWasm = await checkFile(join(coreDirectory, "ffmpeg-core.wasm"));

  // WASM magic bytes followed by binary format version 1.
  // This verifies the header, not successful compilation or engine loading.
  assert.deepEqual(Array.from(coreWasm.bytes.subarray(0, 8)), [0, 97, 115, 109, 1, 0, 0, 0]);

  console.log(`Wrapper package: ${wrapper.metadata.name}@${wrapper.metadata.version}`);
  console.log(`Core package: ${core.metadata.name}@${core.metadata.version}`);
  console.log(`Wrapper ESM directory: ${wrapperDirectory}`);
  console.log(`Core ESM directory: ${coreDirectory}`);

  console.table([
    {
      asset: "ffmpeg-core.js",
      sizeBytes: coreJavaScript.sizeBytes,
      sha256: coreJavaScript.sha256,
    },
    {
      asset: "ffmpeg-core.wasm",
      sizeBytes: coreWasm.sizeBytes,
      sha256: coreWasm.sha256,
    },
  ]);

  console.log(`Wrapper JavaScript modules checked: ${wrapperModules.length}`);
  console.log("Pinned browser engine assets passed.");
  console.log("Browser initialization and media execution are not covered by this check.");
}

try {
  await main();
} catch (error) {
  console.error("Browser engine asset verification failed.");
  console.error(error);
  process.exitCode = 1;
}
