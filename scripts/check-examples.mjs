import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run through npm run check:examples.");

const args = process.argv.slice(2);
assert.equal(args.length, 3, "Provide absolute FFmpeg, FFprobe, and fixture paths.");
const [ffmpegPath, ffprobePath, fixturePath] = args;

for (const file of args) {
  assert.equal(resolve(file), file, "Use absolute paths: " + file);
  assert.ok(existsSync(file), "Missing file: " + file);
}

const temporary = mkdtempSync(join(tmpdir(), "mavio-examples-"));
const examplesDirectory = join(temporary, "examples");

cpSync(join(root, "examples"), examplesDirectory, {
  recursive: true,
  filter(source) {
    return !["node_modules", "mavio-engine", "app.js", "package-lock.json"].includes(
      basename(source),
    );
  },
});

function npm(arguments_, cwd = root) {
  return execFileSync(process.execPath, [npmCli, ...arguments_], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
  });
}

function run(command, arguments_, cwd = root) {
  return execFileSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
}

console.info("Preparing SDK archive.");
const [packed] = JSON.parse(
  npm([
    "pack",
    "--workspace=@vormir/mavio",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    temporary,
  ]),
);
const archive = join(temporary, packed.filename);

for (const name of ["node", "vanilla-js", "vanilla-ts"]) {
  const directory = join(examplesDirectory, name);
  console.info("Installing packaged consumer: " + name);

  npm(["install", archive, "--ignore-scripts", "--no-audit", "--no-fund"], directory);

  const consumerRequire = createRequire(join(directory, "package.json"));
  const entry = name === "node" ? "node" : "browser";
  assert.equal(
    realpathSync(consumerRequire.resolve("@vormir/mavio/" + entry)),
    realpathSync(join(directory, "node_modules/@vormir/mavio/dist/" + entry + ".js")),
  );

  if (name !== "node") {
    const output = npm(["run", "assets"], directory);
    assert.ok(output.includes("restore-stack-after-native-entry-v1"));

    const manifest = JSON.parse(
      readFileSync(join(directory, "public/mavio-engine/manifest.json"), "utf8"),
    );
    assert.equal(manifest.wrapperVersion, "0.12.15");
    const kitPins = JSON.parse(
      readFileSync(join(root, "packages/mavio/scripts/browser-engine-kit-pins.json"), "utf8"),
    );
    assert.equal(manifest.candidateId, kitPins.candidateId);
    assert.equal(manifest.ffmpegVersion, "5.1.10");
    assert.equal(manifest.files["ffmpeg-core.wasm"], kitPins.files["core/ffmpeg-core.wasm"]);
    for (const [asset, expected] of Object.entries(kitPins.files)) {
      if (!asset.startsWith("core/")) assert.equal(manifest.files[asset], expected, asset);
    }

    npm(["run", "build"], directory);
    if (name === "vanilla-ts") npm(["run", "typecheck"], directory);
    assert.ok(existsSync(join(directory, "public/app.js")));
  }

  console.info("PASS: installed package and preparation: " + name);
}

const nodeDirectory = join(examplesDirectory, "node");
const outputPath = join(temporary, "node-output.mp4");

const nodeOutput = run(
  process.execPath,
  [join(nodeDirectory, "main.mjs"), fixturePath, outputPath, ffmpegPath, ffprobePath],
  nodeDirectory,
);

assert.ok(nodeOutput.includes("MAVIO_NODE_EXAMPLE_OK"));

const metadata = JSON.parse(
  run(ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", outputPath]),
);
assert.ok(
  metadata.streams.some((stream) => stream.codec_type === "video" && stream.codec_name === "h264"),
);
assert.ok(
  metadata.streams.some((stream) => stream.codec_type === "audio" && stream.codec_name === "aac"),
);
assert.ok(Number(metadata.format.duration) > 0);

run(ffmpegPath, ["-hide_banner", "-v", "error", "-xerror", "-i", outputPath, "-f", "null", "-"]);

console.info("PASS: standalone Node example executed; output probed and decoded.");
console.info("PASS: Browser builds and TypeScript consumer checks.");
console.info("Starting Browser example interaction checks.");
execFileSync(
  process.execPath,
  [
    join(root, "scripts/check-browser-examples.mjs"),
    examplesDirectory,
    ffmpegPath,
    ffprobePath,
    fixturePath,
  ],
  {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    timeout: 300_000,
  },
);
console.info("PASS: all three installed-package examples.");
console.info("EXAMPLES_CONSUMER_DIRECTORY=" + examplesDirectory);
