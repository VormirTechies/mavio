import assert from "node:assert/strict";
import { access, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { publishNativeFile } from "../../dist/engines/native/publication.js";
import { isPreservedFailure } from "../../dist/core/errors.js";

async function withFiles(run) {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "mavio-publication-test-"));
  const staged = join(directory, "staged.mp4");
  const target = join(directory, "published.mp4");

  try {
    await writeFile(staged, "complete output", { flag: "wx" });
    await run({ directory, staged, target });
  } finally {
    assert.equal(dirname(directory), root);
    assert.ok(basename(directory).startsWith("mavio-publication-test-"));
    await rm(directory, { recursive: true, force: true });
  }
}

function context(overrides = {}) {
  return {
    jobId: "publication-test",
    signal: new AbortController().signal,
    beginCommit: () => true,
    ...overrides,
  };
}

test("publication survives removal of its staging name", async () => {
  await withFiles(async ({ staged, target }) => {
    let commits = 0;

    await publishNativeFile(
      staged,
      target,
      context({
        beginCommit() {
          commits++;
          return true;
        },
      }),
    );

    assert.equal(commits, 1);
    await unlink(staged);
    assert.equal(await readFile(target, "utf8"), "complete output");
  });
});

test("publication preserves an existing target", async () => {
  await withFiles(async ({ staged, target }) => {
    await writeFile(target, "existing contents", { flag: "wx" });

    await assert.rejects(publishNativeFile(staged, target, context()), { code: "OUTPUT_EXISTS" });

    assert.equal(await readFile(target, "utf8"), "existing contents");
    assert.equal(await readFile(staged, "utf8"), "complete output");
  });
});

test("two competing publications have exactly one winner", async () => {
  await withFiles(async ({ directory, staged, target }) => {
    const second = join(directory, "second.mp4");
    await writeFile(second, "second output", { flag: "wx" });

    const results = await Promise.allSettled([
      publishNativeFile(staged, target, context()),
      publishNativeFile(second, target, context()),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);

    const failure = results.find((result) => result.status === "rejected");
    assert.equal(failure.reason.code, "OUTPUT_EXISTS");
    assert.ok(["complete output", "second output"].includes(await readFile(target, "utf8")));
  });
});

test("pre-abort and a denied commit gate leave the target absent", async () => {
  await withFiles(async ({ staged, target }) => {
    const controller = new AbortController();
    controller.abort("stopped");

    let commits = 0;
    await assert.rejects(
      publishNativeFile(
        staged,
        target,
        context({
          signal: controller.signal,
          beginCommit() {
            commits++;
            return true;
          },
        }),
      ),
      { code: "CANCELLED" },
    );
    assert.equal(commits, 0);

    await assert.rejects(
      publishNativeFile(
        staged,
        target,
        context({
          beginCommit: () => false,
        }),
      ),
      { code: "CANCELLED" },
    );

    await assert.rejects(access(target), { code: "ENOENT" });
  });
});

test("late cancellation does not revoke granted publication", async () => {
  await withFiles(async ({ staged, target }) => {
    const controller = new AbortController();

    await publishNativeFile(
      staged,
      target,
      context({
        signal: controller.signal,
        beginCommit() {
          controller.abort("after grant");
          return true;
        },
      }),
    );

    assert.equal(await readFile(target, "utf8"), "complete output");
  });
});

test("cross-filesystem failure remains an IO error after late cancellation", async () => {
  await withFiles(async ({ staged, target }) => {
    const controller = new AbortController();
    const cause = Object.assign(new Error("Cross-device link"), {
      code: "EXDEV",
    });

    await assert.rejects(
      publishNativeFile(staged, target, context({ signal: controller.signal }), {
        async link() {
          controller.abort("late cancellation");
          throw cause;
        },
      }),
      (error) => {
        assert.equal(error.code, "IO_ERROR");
        assert.equal(error.cause, cause);
        assert.ok(isPreservedFailure(error));
        return true;
      },
    );

    await assert.rejects(access(target), { code: "ENOENT" });
    assert.equal(await readFile(staged, "utf8"), "complete output");
  });
});

// M7 Native publication boundary checks.
for (const kind of ["empty-file", "directory"]) {
  test(`publication rejects ${kind} staging before requesting commit`, async () => {
    const { mkdir } = await import("node:fs/promises");

    await withFiles(async ({ staged, target }) => {
      await unlink(staged);

      if (kind === "directory") {
        await mkdir(staged);
      } else {
        await writeFile(staged, "", { flag: "wx" });
      }

      let commits = 0;

      await assert.rejects(
        publishNativeFile(
          staged,
          target,
          context({
            beginCommit() {
              commits++;
              return true;
            },
          }),
        ),
        {
          code: "EXECUTION_FAILED",
          details: { reason: "INVALID_STAGED_OUTPUT" },
        },
      );

      assert.equal(commits, 0);
      await assert.rejects(access(target), { code: "ENOENT" });
    });
  });
}

test("publication preserves a destination created immediately before linking", async () => {
  const { link } = await import("node:fs/promises");

  await withFiles(async ({ staged, target }) => {
    let attempts = 0;

    await assert.rejects(
      publishNativeFile(staged, target, context(), {
        async link(source, destination) {
          attempts++;
          await writeFile(destination, "late existing contents", { flag: "wx" });
          await link(source, destination);
        },
      }),
      {
        code: "OUTPUT_EXISTS",
        details: { reason: "OUTPUT_ALREADY_EXISTS" },
      },
    );

    assert.equal(attempts, 1);
    assert.equal(await readFile(target, "utf8"), "late existing contents");
    assert.equal(await readFile(staged, "utf8"), "complete output");
  });
});

test("publication preserves an existing hard-link alias of staging", async () => {
  const { link } = await import("node:fs/promises");

  await withFiles(async ({ staged, target }) => {
    await link(staged, target);

    await assert.rejects(publishNativeFile(staged, target, context()), { code: "OUTPUT_EXISTS" });

    assert.equal(await readFile(staged, "utf8"), "complete output");
    assert.equal(await readFile(target, "utf8"), "complete output");
  });
});
