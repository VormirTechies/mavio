import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { patchCandidateBrowserCore } from "./experimental-core.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function prepareBrowserAssetsFromKit(destination, kitDirectory) {
  const pins = JSON.parse(
    await readFile(new URL("./browser-engine-kit-pins.json", import.meta.url), "utf8"),
  );
  const supplied = JSON.parse(await readFile(join(kitDirectory, "engine-kit.json"), "utf8"));
  assert.deepEqual(supplied, pins, "Unsupported Browser engine kit manifest.");

  const files = new Map();
  for (const [name, expected] of Object.entries(pins.files)) {
    assert.match(name, /^(core|notices|sources)\/[a-zA-Z0-9._-]+$/);
    const bytes = await readFile(join(kitDirectory, name));
    assert.equal(sha256(bytes), expected, "Browser engine kit hash mismatch: " + name);
    if (name.startsWith("core/")) {
      const target = name.slice(5);
      assert.ok(["ffmpeg-core.js", "ffmpeg-core.wasm"].includes(target));
      files.set(target, target.endsWith(".js") ? patchCandidateBrowserCore(bytes) : bytes);
    } else {
      files.set(name, bytes);
    }
  }
  for (const name of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
    assert.ok(files.has(name), "Missing kit core asset: " + name);
  }

  const sdk = createRequire(import.meta.url);
  const wrapper = dirname(sdk.resolve("@ffmpeg/ffmpeg/worker"));
  const metadata = JSON.parse(await readFile(join(wrapper, "../../package.json"), "utf8"));
  assert.equal(metadata.version, "0.12.15");
  const modules = (await readdir(wrapper)).filter((name) => name.endsWith(".js")).sort();
  for (const name of ["index.js", "classes.js", "worker.js"]) {
    assert.ok(modules.includes(name), "Missing wrapper module: " + name);
  }
  for (const name of modules) {
    files.set("wrapper/" + name, await readFile(join(wrapper, name)));
  }
  files.set(
    "notices/ffmpegwasm-wrapper-MIT.txt",
    await readFile(new URL("../third-party/ffmpegwasm-MIT.txt", import.meta.url)),
  );
  files.set(
    "ENGINE-LICENSING.md",
    Buffer.from(
      [
        "# Mavio candidate v2 engine deployment",
        "",
        "Status: review-only; security and licensing release acceptance remain open.",
        "Candidate: " + pins.candidateId,
        "",
        "Preserve the notices/ and sources/ directories with these generated assets.",
        "Source archive: sources/mavio-candidate-v2-sources.tar.gz.",
        "Modifications: notices/MAVIO-MODIFICATIONS.md.",
        "The JavaScript restores the stack after both native entry points.",
        "The candidate WASM is copied unchanged.",
        "",
        "This guide records deployment contents, not complete licensing clearance.",
        "",
      ].join("\n"),
    ),
  );

  files.set(
    "notices/musl-EMBEDDED-NOTICES.txt",
    await readFile(new URL("../third-party/musl-EMBEDDED-NOTICES.txt", import.meta.url)),
  );

  const manifest = {
    status: "candidate-v2-integration-under-review",
    candidateId: pins.candidateId,
    wrapperVersion: "0.12.15",
    ffmpegVersion: "5.1.10",
    correction: "restore-stack-after-native-entry-v1",
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)])),
  };

  // Verify every input before creating a fresh destination.
  await mkdir(destination, { recursive: false });
  for (const name of ["wrapper", "notices", "sources"]) {
    await mkdir(join(destination, name));
  }
  for (const [name, bytes] of files) {
    await writeFile(join(destination, name), bytes, { flag: "wx" });
  }
  await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
  });
  return manifest;
}
