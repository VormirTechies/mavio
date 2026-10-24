import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const CANDIDATE_CORE_HASHES = Object.freeze({
  "ffmpeg-core.js": "e9c5f7531efe82b0c68dd63b1ac5d7ef2245a52f0b513ff012846b87811bf7b5",
  "ffmpeg-core.wasm": "6cc6ea8f9273549eaa1b8abf190eff9e8403f7dcdd96302e24bc36e48d816568",
});

export function verifyCandidateCoreAsset(name, bytes) {
  assert.ok(Object.hasOwn(CANDIDATE_CORE_HASHES, name), "Unknown candidate asset.");
  const actual = createHash("sha256").update(bytes).digest("hex");
  assert.equal(actual, CANDIDATE_CORE_HASHES[name], "Candidate asset hash mismatch: " + name);
}

export function patchCandidateBrowserCore(bytes) {
  verifyCandidateCoreAsset("ffmpeg-core.js", bytes);
  let source = bytes.toString("utf8");

  for (const method of ["ffmpeg", "ffprobe"]) {
    const original = `Module["_${method}"](args.length,stringsToPtr(args))`;
    assert.equal(
      source.split(original).length,
      2,
      `Expected exactly one candidate ${method} entry point.`,
    );
    source = source.replace(
      original,
      `const mavioStack=stackSave();try{${original}}finally{stackRestore(mavioStack)}`,
    );
  }

  return Buffer.from(
    "/* Experimental Mavio candidate stack restoration; WASM unchanged. */\n" + source,
  );
}
