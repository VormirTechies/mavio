import assert from "node:assert/strict";
import { mkdtemp, readFile, rmdir, symlink, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { patchBrowserCore } from "../packages/mavio/scripts/browser-assets.mjs";
import { assertStackControl } from "./browser-stack-control.mjs";

const original = await readFile(
  new URL("../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js", import.meta.url),
);
const patched = patchBrowserCore(original).toString("utf8");

test("asset CLI starts when its module URL uses a filesystem alias", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mavio-cli-alias-"));
  const alias = join(directory, "scripts-alias");
  const actual = dirname(
    fileURLToPath(new URL("../packages/mavio/scripts/browser-assets.mjs", import.meta.url)),
  );
  await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
  try {
    // Preserve the alias in import.meta.url while realpath(argv[1]) resolves it.
    // This recreates the same mismatch as Windows RUNNER~1 temp paths.
    const result = spawnSync(
      process.execPath,
      ["--preserve-symlinks-main", join(alias, "browser-assets.mjs")],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Usage: mavio-browser-assets/);
  } finally {
    await unlink(alias);
    await rmdir(directory);
  }
});

test("stack-control oracle requires both observations and fails closed", () => {
  const result = (observations) =>
    `MAVIO_STACK_CONTROL_RESULT ${JSON.stringify({ mode: "STACK_CONTROL", observations })}\n`;
  const leaking = [
    { method: "exec", before: 10000, after: 9232, exitCode: 0 },
    { method: "ffprobe", before: 9232, after: 7104, exitCode: 0 },
  ];
  const stable = leaking.map((item) => ({ ...item, before: 10000, after: 10000 }));
  assertStackControl(result(leaking), false);
  assertStackControl(result(stable), true);
  assert.throws(() => assertStackControl(result(leaking), true));
  assert.throws(() => assertStackControl(result(stable), false));
  assert.throws(() => assertStackControl(result(leaking.slice(0, 1)), false));
  assert.throws(() => assertStackControl('MAVIO_REPLAY_RESULT {"outcome":"INCONCLUSIVE"}', false));
  assert.throws(() =>
    assertStackControl(result(leaking) + 'MAVIO_REPLAY_RESULT {"outcome":"INCONCLUSIVE"}', false),
  );
});

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
