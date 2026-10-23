import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import test from "node:test";
import { createNativeWorkspace } from "../../dist/engines/native/workspace.js";

function context(signal = new AbortController().signal) {
  return { jobId: "workspace-test", signal };
}

test("workspace copies the supplied byte view without detaching its buffer", async () => {
  const workspace = await createNativeWorkspace();
  const original = new Uint8Array([99, 1, 2, 3, 88]);
  const view = original.subarray(1, 4);
  let inputPath;

  try {
    const pending = workspace.writeInput(view, context());

    // The workspace owns a snapshot before its first asynchronous write.
    original.fill(7);

    inputPath = await pending;

    assert.equal(basename(inputPath), "input.bin");
    assert.deepEqual([...(await readFile(inputPath))], [1, 2, 3]);
    assert.equal(original.byteLength, 5);
    assert.deepEqual([...original], [7, 7, 7, 7, 7]);
  } finally {
    await workspace.dispose();
  }

  await assert.rejects(access(dirname(inputPath)), { code: "ENOENT" });
});

test("empty input is rejected without consuming the workspace", async () => {
  const workspace = await createNativeWorkspace();

  try {
    await assert.rejects(workspace.writeInput(new Uint8Array(), context()), {
      code: "INVALID_INPUT",
    });

    const path = await workspace.writeInput(new Uint8Array([1]), context());
    assert.deepEqual([...(await readFile(path))], [1]);
  } finally {
    await workspace.dispose();
  }
});

test("pre-aborted staging leaves the workspace available for cleanup", async () => {
  const workspace = await createNativeWorkspace();
  const controller = new AbortController();
  controller.abort("stopped");

  try {
    await assert.rejects(workspace.writeInput(new Uint8Array([1]), context(controller.signal)), {
      code: "CANCELLED",
      jobId: "workspace-test",
      cause: "stopped",
    });
  } finally {
    await workspace.dispose();
  }
});

test("a workspace cannot overwrite its first staged input", async () => {
  const workspace = await createNativeWorkspace();

  try {
    const path = await workspace.writeInput(new Uint8Array([1]), context());

    await assert.rejects(workspace.writeInput(new Uint8Array([2]), context()), {
      code: "INVALID_INPUT",
    });

    assert.deepEqual([...(await readFile(path))], [1]);
  } finally {
    await workspace.dispose();
  }
});

test("successful disposal is shared and prevents further writes", async () => {
  const workspace = await createNativeWorkspace();

  const first = workspace.dispose();
  const second = workspace.dispose();

  assert.equal(first, second);
  await first;

  await assert.rejects(workspace.writeInput(new Uint8Array([1]), context()), { code: "DISPOSED" });

  assert.equal(workspace.dispose(), first);
});

test("failed cleanup can be retried without reopening the workspace", async () => {
  let attempts = 0;
  const failure = new Error("Simulated cleanup failure");

  const workspace = await createNativeWorkspace({
    async remove(directory) {
      attempts += 1;

      if (attempts === 1) throw failure;

      await rm(directory, { recursive: true, force: true });
    },
  });

  const path = await workspace.writeInput(new Uint8Array([1]), context());

  try {
    await assert.rejects(workspace.dispose(), {
      code: "CLEANUP_FAILED",
      cause: failure,
      details: { reason: "WORKSPACE_CLEANUP_FAILED" },
    });

    await assert.rejects(workspace.writeInput(new Uint8Array([2]), context()), {
      code: "DISPOSED",
    });
  } finally {
    await workspace.dispose();
  }

  assert.equal(attempts, 2);
  await assert.rejects(access(dirname(path)), { code: "ENOENT" });
});

test("workspace output bytes survive cleanup and share the input workspace", async () => {
  const workspace = await createNativeWorkspace();
  const outputPath = workspace.getOutputPath();
  let bytes;

  try {
    assert.equal(workspace.getOutputPath(), outputPath);
    assert.equal(basename(outputPath), "output.mp4");
    await assert.rejects(access(outputPath), { code: "ENOENT" });

    const inputPath = await workspace.writeInput(new Uint8Array([9]), context());

    assert.equal(dirname(inputPath), dirname(outputPath));
    assert.notEqual(inputPath, outputPath);

    await writeFile(outputPath, new Uint8Array([1, 2, 3]), { flag: "wx" });

    bytes = await workspace.readOutput(context());
    assert.equal(bytes.constructor, Uint8Array);
    assert.deepEqual([...bytes], [1, 2, 3]);
  } finally {
    await workspace.dispose();
  }

  await assert.rejects(access(dirname(outputPath)), { code: "ENOENT" });
  assert.deepEqual([...bytes], [1, 2, 3]);
});

test("workspace output reading rejects missing and empty files", async () => {
  const workspace = await createNativeWorkspace();

  try {
    await assert.rejects(workspace.readOutput(context()), {
      code: "IO_ERROR",
      details: { reason: "OUTPUT_READ_FAILED" },
    });

    await writeFile(workspace.getOutputPath(), new Uint8Array(), {
      flag: "wx",
    });

    await assert.rejects(workspace.readOutput(context()), {
      code: "EXECUTION_FAILED",
      details: { reason: "EMPTY_ENCODED_OUTPUT" },
    });
  } finally {
    await workspace.dispose();
  }
});

test("workspace rejects cancelled reads and access after disposal", async () => {
  let reads = 0;
  const workspace = await createNativeWorkspace({
    async read() {
      reads++;
      return new Uint8Array([1]);
    },
  });

  const controller = new AbortController();
  controller.abort("stopped");

  try {
    await assert.rejects(workspace.readOutput(context(controller.signal)), {
      code: "CANCELLED",
      cause: "stopped",
    });
    assert.equal(reads, 0);
  } finally {
    await workspace.dispose();
  }

  assert.throws(() => workspace.getOutputPath(), { code: "DISPOSED" });
  await assert.rejects(workspace.readOutput(context()), { code: "DISPOSED" });
});

test("workspace disposal waits for an active output read", async () => {
  let finishRead;
  const original = new Uint8Array([4, 5]);
  const workspace = await createNativeWorkspace({
    read() {
      return new Promise((resolve) => {
        finishRead = resolve;
      });
    },
  });

  const directory = dirname(workspace.getOutputPath());
  const pendingRead = workspace.readOutput(context());
  const pendingDisposal = workspace.dispose();

  try {
    // An unresolved read keeps the workspace alive.
    await access(directory);
  } finally {
    finishRead(original);
    await pendingDisposal;
  }

  const bytes = await pendingRead;
  original.fill(0);

  assert.deepEqual([...bytes], [4, 5]);
  await assert.rejects(access(directory), { code: "ENOENT" });
});

for (const outcome of ["resolve", "reject"]) {
  test(`settled-write cleanup waits for pending reads: ${outcome}`, { timeout: 3000 }, async () => {
    let finishRead;
    let failRead;
    let removals = 0;
    let ownedDirectory;
    const failure = new Error("Controlled read failure.");

    const workspace = await createNativeWorkspace({
      read() {
        return new Promise((resolve, reject) => {
          finishRead = resolve;
          failRead = reject;
        });
      },
      async remove(directory) {
        assert.equal(directory, ownedDirectory);
        removals++;
        await rm(directory, { recursive: true, force: true });
      },
    });

    ownedDirectory = dirname(workspace.getOutputPath());

    // Ensure the write has settled before starting the controlled read.
    await workspace.writeInput(new Uint8Array([1]), context());

    const reading = workspace.readOutput(context());
    const observed = reading.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const disposal = workspace.dispose();
    let result;

    try {
      // Allow disposal's scheduled cleanup to start if it is not waiting.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(removals, 0, "Cleanup started before the read settled.");
    } finally {
      if (outcome === "resolve") finishRead(new Uint8Array([4, 5]));
      else failRead(failure);

      result = await observed;
      await disposal;
    }

    assert.equal(removals, 1);
    await assert.rejects(access(ownedDirectory), { code: "ENOENT" });

    if (outcome === "resolve") {
      assert.deepEqual([...result.value], [4, 5]);
    } else {
      assert.equal(result.error.code, "IO_ERROR");
      assert.equal(result.error.cause, failure);
    }
  });
}
