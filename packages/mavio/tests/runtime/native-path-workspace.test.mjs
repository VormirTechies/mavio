import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { createNativePathWorkspace } from "../../dist/engines/native/path-workspace.js";
import { publishNativeFile } from "../../dist/engines/native/publication.js";

async function withDirectory(run) {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "mavio-path-workspace-test-"));

  try {
    await run(directory);
  } finally {
    assert.equal(dirname(directory), root);
    assert.ok(basename(directory).startsWith("mavio-path-workspace-test-"));
    await rm(directory, { recursive: true, force: true });
  }
}

test("destination-side staging publishes successfully and cleanup preserves the target", async () => {
  await withDirectory(async (directory) => {
    const target = join(directory, "finished output.mp4");
    const workspace = await createNativePathWorkspace(target);
    const staged = workspace.getOutputPath();

    try {
      assert.equal(dirname(dirname(staged)), directory);
      assert.notEqual(staged, target);
      await assert.rejects(access(target), { code: "ENOENT" });

      await writeFile(staged, "completed media", { flag: "wx" });

      await publishNativeFile(staged, target, {
        jobId: "path-workspace-test",
        signal: new AbortController().signal,
        beginCommit: () => true,
      });
    } finally {
      await workspace.dispose();
    }

    await assert.rejects(access(dirname(staged)), { code: "ENOENT" });
    assert.equal(await readFile(target, "utf8"), "completed media");
    assert.deepEqual(await readdir(directory), ["finished output.mp4"]);
  });
});

test("occupied files and directories reject without allocating a workspace", async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, "existing.mp4");
    const folder = join(directory, "existing-directory");

    await writeFile(file, "preserve this", { flag: "wx" });
    await mkdir(folder);
    const before = (await readdir(directory)).sort();

    for (const target of [file, folder]) {
      await assert.rejects(createNativePathWorkspace(target), { code: "OUTPUT_EXISTS" });
    }

    assert.equal(await readFile(file, "utf8"), "preserve this");
    assert.deepEqual((await readdir(directory)).sort(), before);
  });
});

test("missing destination parents fail without creating directories", async () => {
  await withDirectory(async (directory) => {
    const missingParent = join(directory, "missing");

    await assert.rejects(createNativePathWorkspace(join(missingParent, "output.mp4")), {
      code: "IO_ERROR",
    });

    await assert.rejects(access(missingParent), { code: "ENOENT" });
    assert.deepEqual(await readdir(directory), []);
  });
});

test("invalid destination paths reject before workspace allocation", async () => {
  for (const path of ["", "relative.mp4", "invalid\0path"]) {
    await assert.rejects(createNativePathWorkspace(path), { code: "INVALID_OPTIONS" });
  }
});
