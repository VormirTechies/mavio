import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { patchBrowserCore } from "../packages/mavio/scripts/browser-assets.mjs";

const original = await readFile(
  new URL("../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js", import.meta.url),
);
const patched = patchBrowserCore(original).toString("utf8");

test("asset patch rejects changed or already patched cores", () => {
  assert.throws(() => patchBrowserCore(Buffer.from("unsupported")), /Unsupported core/);
  assert.throws(() => patchBrowserCore(Buffer.from(patched)), /Unsupported core/);
});

for (const method of ["exec", "ffprobe"]) {
  test(`${method} restores the stack on native abort and preserves unexpected failures`, () => {
    const start = patched.indexOf(`function ${method}(`);
    const end = patched.indexOf("function ", start + 1);
    const binding = patched.slice(start, end);
    let stack = 1_000_000;
    const calls = [];
    const module = { DEFAULT_ARGS: ["ffmpeg"], DEFAULT_ARGS_FFPROBE: ["ffprobe"], ret: 0 };
    const entry = method === "exec" ? "_ffmpeg" : "_ffprobe";
    module[entry] = (argc, argv) => {
      calls.push({ argc, argv });
      stack -= 4096;
      throw new Error("Aborted()");
    };
    const invoke = runInNewContext(`${binding}; ${method}`, {
      Module: module,
      stringsToPtr: (args) => args,
      stackSave: () => stack,
      stackRestore: (saved) => {
        stack = saved;
      },
    });
    for (let i = 0; i < 1000; i++) assert.equal(invoke("-version"), 0);
    assert.equal(stack, 1_000_000);
    assert.deepEqual(Array.from(calls[0].argv), [
      method === "exec" ? "ffmpeg" : "ffprobe",
      "-version",
    ]);
    const failure = new Error("memory access out of bounds");
    module[entry] = () => {
      stack -= 4096;
      throw failure;
    };
    assert.throws(
      () => invoke("-version"),
      (error) => error === failure,
    );
    assert.equal(stack, 1_000_000);
  });
}
