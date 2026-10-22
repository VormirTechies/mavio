import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserWorkspace } from "../../dist/engines/browser/workspace.js";

function fixture() {
  const directories = new Map();
  const calls = [];
  const failedFiles = new Set();
  let failDirectoryRemoval = false;

  const worker = {
    async createDir(path) {
      calls.push(["mkdir", path]);

      if (directories.has(path)) throw new Error("Already exists.");
      directories.set(path, new Map());
      return true;
    },

    async listDir(path) {
      calls.push(["list", path]);

      const entries = directories.get(path);
      if (!entries) throw new Error("Missing directory.");

      return [
        { name: ".", isDir: true },
        { name: "..", isDir: true },
        ...Array.from(entries, ([name, isDir]) => ({ name, isDir })),
      ];
    },

    async deleteFile(path) {
      calls.push(["unlink", path]);

      if (failedFiles.has(path)) throw new Error("Simulated unlink failure.");

      const separator = path.lastIndexOf("/");
      const directory = path.slice(0, separator);
      const name = path.slice(separator + 1);
      const entries = directories.get(directory);

      if (!entries?.has(name)) throw new Error("Missing file.");
      entries.delete(name);
      return true;
    },

    async deleteDir(path) {
      calls.push(["rmdir", path]);

      if (failDirectoryRemoval) {
        throw new Error("Simulated directory removal failure.");
      }

      const entries = directories.get(path);
      if (!entries || entries.size !== 0) throw new Error("Not empty.");

      directories.delete(path);
      return true;
    },
  };

  return {
    worker,
    directories,
    calls,
    failedFiles,
    setDirectoryFailure(value) {
      failDirectoryRemoval = value;
    },
  };
}

test("browser workspaces use distinct directories and fixed internal paths", async () => {
  const { worker } = fixture();
  const first = await createBrowserWorkspace(worker);
  const second = await createBrowserWorkspace(worker);

  assert.notEqual(first.directory, second.directory);
  assert.equal(first.inputPath, `${first.directory}/input.bin`);
  assert.equal(first.probePath, `${first.directory}/probe.json`);
  assert.equal(Object.isFrozen(first), true);

  await first.cleanup();
  await second.cleanup();
});

test("a workspace collision never claims or deletes the existing directory", async () => {
  const { worker, directories, calls } = fixture();
  directories.set("/mavio-collision", new Map([["sentinel", false]]));

  await assert.rejects(createBrowserWorkspace(worker, "workspace-test", "collision"), {
    code: "IO_ERROR",
    stage: "preparing",
  });

  assert.equal(directories.get("/mavio-collision").has("sentinel"), true);
  assert.deepEqual(calls, [["mkdir", "/mavio-collision"]]);
});

test("workspace cleanup removes owned files and preserves neighboring files", async () => {
  const { worker, directories, calls } = fixture();
  directories.set("/outside", new Map([["sentinel", false]]));

  const workspace = await createBrowserWorkspace(worker, "workspace-test", "owned");

  directories.get(workspace.directory).set("input.bin", false);
  directories.get(workspace.directory).set("probe.json", false);

  await workspace.cleanup();

  assert.equal(directories.has(workspace.directory), false);
  assert.equal(directories.get("/outside").has("sentinel"), true);
  assert.deepEqual(
    calls.filter(([operation]) => operation === "unlink"),
    [
      ["unlink", workspace.inputPath],
      ["unlink", workspace.probePath],
    ],
  );
});

test("cleanup continues after a file failure and can retry remaining files", async () => {
  const { worker, directories, failedFiles } = fixture();
  const workspace = await createBrowserWorkspace(worker, "workspace-test", "retry-files");

  const entries = directories.get(workspace.directory);
  entries.set("input.bin", false);
  entries.set("probe.json", false);
  failedFiles.add(workspace.inputPath);

  await assert.rejects(workspace.cleanup(), {
    code: "CLEANUP_FAILED",
    stage: "finalizing",
  });

  assert.equal(entries.has("input.bin"), true);
  assert.equal(entries.has("probe.json"), false);

  failedFiles.clear();
  await workspace.cleanup();

  assert.equal(directories.has(workspace.directory), false);
});

test("directory removal failure can be retried after files are gone", async () => {
  const { worker, directories, setDirectoryFailure } = fixture();
  const workspace = await createBrowserWorkspace(worker, "workspace-test", "retry-directory");

  directories.get(workspace.directory).set("input.bin", false);
  setDirectoryFailure(true);

  await assert.rejects(workspace.cleanup(), {
    code: "CLEANUP_FAILED",
  });

  assert.equal(directories.get(workspace.directory).size, 0);

  setDirectoryFailure(false);
  await workspace.cleanup();

  assert.equal(directories.has(workspace.directory), false);
});

test("concurrent and repeated cleanup performs one successful removal", async () => {
  const { worker, calls } = fixture();
  const workspace = await createBrowserWorkspace(worker, "workspace-test", "idempotent");

  await Promise.all([workspace.cleanup(), workspace.cleanup(), workspace.cleanup()]);

  await workspace.cleanup();

  assert.equal(calls.filter(([operation]) => operation === "rmdir").length, 1);
});

test("workspace cleanup refuses traversal and nested directories", async () => {
  const { worker, directories, calls } = fixture();
  const workspace = await createBrowserWorkspace(worker, "workspace-test", "unsafe-entry");

  const entries = directories.get(workspace.directory);
  entries.set("../sentinel", false);
  entries.set("nested", true);
  entries.set("probe.json", false);

  await assert.rejects(workspace.cleanup(), {
    code: "CLEANUP_FAILED",
  });

  assert.deepEqual(
    calls.filter(([operation]) => operation === "unlink"),
    [["unlink", workspace.probePath]],
  );

  entries.delete("../sentinel");
  entries.delete("nested");
  await workspace.cleanup();
});

test("unsafe workspace identifiers reject before filesystem calls", async () => {
  const { worker, calls } = fixture();

  for (const identifier of ["", "../outside", "a/b", "a\\b", "a\0b"]) {
    await assert.rejects(createBrowserWorkspace(worker, "workspace-test", identifier), {
      code: "INVALID_OPTIONS",
    });
  }

  assert.deepEqual(calls, []);
});
