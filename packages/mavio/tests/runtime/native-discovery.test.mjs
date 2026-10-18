import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { captureNativeConfiguration } from "../../dist/engines/native/config.js";
import { discoverNativeTools } from "../../dist/engines/native/discovery.js";

function configuration(options = {}, path = "/first:/second") {
  return captureNativeConfiguration(options, {
    cwd: "/project",
    path,
    platform: "posix",
  });
}

function context(signal = new AbortController().signal) {
  return { jobId: "discovery-test", signal };
}

function missing() {
  return Object.assign(new Error("Missing candidate."), { code: "ENOENT" });
}

const regular = () => ({ isFile: () => true });
const directory = () => ({ isFile: () => false });

test("discovery selects each tool independently in candidate order", async () => {
  const inspected = [];

  const result = await discoverNativeTools(configuration(), context(), async (path) => {
    inspected.push(path);

    if (path === "/first/ffmpeg") return directory();
    return regular();
  });

  assert.deepEqual(result, {
    ffmpegPath: "/second/ffmpeg",
    ffprobePath: "/first/ffprobe",
  });
  assert.deepEqual(inspected, ["/first/ffmpeg", "/second/ffmpeg", "/first/ffprobe"]);
  assert.ok(Object.isFrozen(result));
});

test("real filesystem discovery skips directories without executing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mavio-discovery-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const windows = process.platform === "win32";
  const ffmpeg = windows ? "ffmpeg.exe" : "ffmpeg";
  const ffprobe = windows ? "ffprobe.exe" : "ffprobe";

  try {
    await mkdir(first);
    await mkdir(second);

    // These are inert test files, not actual executables.
    await mkdir(join(first, ffmpeg));
    await writeFile(join(second, ffmpeg), "not executable");
    await writeFile(join(second, ffprobe), "not executable");

    const config = captureNativeConfiguration(
      {},
      {
        cwd: root,
        path: [first, second].join(delimiter),
        platform: windows ? "win32" : "posix",
      },
    );

    const result = await discoverNativeTools(config, context());

    assert.equal(result.ffmpegPath, join(second, ffmpeg));
    assert.equal(result.ffprobePath, join(second, ffprobe));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing explicit overrides never fall back to PATH", async () => {
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const inspected = [];
    const config = configuration({
      [`${tool}Path`]: `/explicit/${tool}`,
    });

    await assert.rejects(
      discoverNativeTools(config, context(), async (path) => {
        inspected.push(path);

        if (path.startsWith("/explicit/")) throw missing();
        return regular();
      }),
      {
        code: "ENGINE_UNAVAILABLE",
        details: { reason: "BINARY_NOT_FOUND", tool },
      },
    );

    assert.deepEqual(
      inspected,
      tool === "ffmpeg" ? ["/explicit/ffmpeg"] : ["/first/ffmpeg", "/explicit/ffprobe"],
    );
  }
});

test("missing tools report bounded actionable diagnostics", async () => {
  for (const tool of ["ffmpeg", "ffprobe"]) {
    await assert.rejects(
      discoverNativeTools(configuration({}, "/private-installation"), context(), async (path) => {
        if (tool === "ffprobe" && path.endsWith("/ffmpeg")) {
          return regular();
        }

        throw missing();
      }),
      (error) => {
        assert.equal(error.code, "ENGINE_UNAVAILABLE");
        assert.equal(error.stage, "preparing");
        assert.equal(error.jobId, "discovery-test");
        assert.deepEqual(error.details, {
          reason: "BINARY_NOT_FOUND",
          tool,
        });
        assert.equal(error.message.includes("/private-installation"), false);
        return true;
      },
    );
  }

  let inspections = 0;

  await assert.rejects(
    discoverNativeTools(configuration({}, ""), context(), async () => {
      inspections += 1;
      return regular();
    }),
    { code: "ENGINE_UNAVAILABLE" },
  );

  assert.equal(inspections, 0);
});

test("inspection errors stop discovery without trying another installation", async () => {
  const failure = Object.assign(new Error("Access denied."), {
    code: "EACCES",
  });
  const inspected = [];

  await assert.rejects(
    discoverNativeTools(configuration(), context(), async (path) => {
      inspected.push(path);
      throw failure;
    }),
    (error) => {
      assert.equal(error.code, "ENGINE_INIT_FAILED");
      assert.equal(error.details.reason, "DISCOVERY_FAILED");
      assert.equal(error.details.tool, "ffmpeg");
      assert.equal(error.cause, failure);
      return true;
    },
  );

  assert.deepEqual(inspected, ["/first/ffmpeg"]);
});

test("pre-aborted discovery performs no filesystem inspection", async () => {
  const controller = new AbortController();
  controller.abort();
  let inspections = 0;

  await assert.rejects(
    discoverNativeTools(configuration(), context(controller.signal), async () => {
      inspections += 1;
      return regular();
    }),
    { code: "CANCELLED", stage: "preparing" },
  );

  assert.equal(inspections, 0);
});

test("abort during inspection waits for it to settle and stops further discovery", async () => {
  const controller = new AbortController();
  let release;
  let inspections = 0;

  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const pending = discoverNativeTools(configuration(), context(controller.signal), async () => {
    inspections += 1;
    await gate;
    return regular();
  });

  let settled = false;
  const observed = pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const rejected = assert.rejects(pending, { code: "CANCELLED" });

  try {
    controller.abort();
    await Promise.resolve();

    assert.equal(settled, false);
    assert.equal(inspections, 1);
  } finally {
    release();
  }

  await Promise.all([observed, rejected]);
  assert.equal(inspections, 1);
});
