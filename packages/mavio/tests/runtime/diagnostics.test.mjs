import assert from "node:assert/strict";
import test from "node:test";
import { createMavio } from "@vormirtech/mavio/node";
import { createDiagnosticReporter } from "../../dist/core/diagnostics.js";
import { createMavioError } from "../../dist/core/errors.js";

function fixture(overrides = {}) {
  const calls = [];
  const engine = {
    id: "diagnostic-fixture",
    runtime: "node",
    async initialize() {
      calls.push("initialize");
      await overrides.initialize?.();
    },
    async capabilities() {
      calls.push("capabilities");
      return {
        engineId: engine.id,
        engineVersion: "test",
        runtime: "node",
        operations: ["metadata"],
        inputKinds: ["bytes"],
        outputKinds: ["bytes"],
        readableContainers: [],
        decoders: [],
        encodings: [],
        limits: {},
      };
    },
    async probe() {
      throw new Error("Unexpected probe.");
    },
    async supports() {
      throw new Error("Unexpected supports.");
    },
    async execute() {
      throw new Error("Unexpected execute.");
    },
    async dispose() {
      calls.push("dispose");
    },
  };
  return { engine, calls };
}

const flush = () => new Promise((resolve) => queueMicrotask(resolve));

test("reporter asynchronously captures only approved immutable fields", async () => {
  const events = [];
  const report = createDiagnosticReporter("fixture", "node", (event) => events.push(event));
  const payload = {
    type: "job-error",
    jobId: "job-1",
    stage: "preparing",
    code: "INVALID_MEDIA",
    message: "PRIVATE_MESSAGE",
    cause: new Error("PRIVATE_CAUSE"),
    path: "PRIVATE_PATH",
    details: { token: "PRIVATE_TOKEN" },
  };

  report(payload);
  assert.equal(events.length, 0);
  payload.code = "IO_ERROR";
  await flush();

  assert.deepEqual(events, [
    {
      engineId: "fixture",
      runtime: "node",
      type: "job-error",
      jobId: "job-1",
      stage: "preparing",
      code: "INVALID_MEDIA",
    },
  ]);
  assert.ok(Object.isFrozen(events[0]));
  assert.throws(() => {
    events[0].code = "IO_ERROR";
  }, TypeError);
  assert.equal(JSON.stringify(events).includes("PRIVATE_"), false);
});

test("disabled reporter does not inspect its payload", () => {
  const report = createDiagnosticReporter("fixture", "node");
  const payload = new Proxy(
    {},
    {
      get() {
        throw new Error("Disabled diagnostics inspected a payload.");
      },
    },
  );
  assert.doesNotThrow(() => report(payload));
});

test("public factory rejects invalid diagnostic observers before initialization", () => {
  for (const observer of [null, true, "debug", {}, []]) {
    const { engine, calls } = fixture();
    assert.throws(() => createMavio({ engine, onDiagnostic: observer }), {
      code: "INVALID_OPTIONS",
    });
    assert.deepEqual(calls, []);
  }
});

test("public diagnostics preserve progress and capture the configured observer", async () => {
  const { engine } = fixture();
  const diagnostics = [];
  const progress = [];
  const options = {
    engine,
    onDiagnostic: (event) => diagnostics.push(event),
  };
  const client = createMavio(options);

  options.onDiagnostic = () => {
    throw new Error("Mutated options observer was used.");
  };

  try {
    assert.deepEqual(diagnostics, []);
    const pending = client.capabilities({
      onProgress: (event) => progress.push(event),
    });
    assert.deepEqual(diagnostics, []);

    await pending;
    await flush();

    const stages = ["queued", "preparing", "running", "finalizing", "completed"];
    assert.deepEqual(
      progress.map((event) => event.stage),
      stages,
    );
    assert.deepEqual(
      diagnostics.map((event) => event.stage),
      stages,
    );
    assert.ok(
      diagnostics.every(
        (event) =>
          event.type === "job-progress" &&
          event.runtime === "node" &&
          event.engineId === engine.id &&
          event.jobId === progress[0].jobId &&
          Object.isFrozen(event),
      ),
    );
    assert.equal(diagnostics.at(-1).percent, 100);
  } finally {
    await client.dispose();
  }
});

test("public error diagnostics exclude cause messages and details", async () => {
  const sensitive = "PRIVATE_FAILURE_AND_TOKEN";
  const failure = createMavioError("ENGINE_UNAVAILABLE", sensitive, {
    details: { reason: sensitive },
    cause: new Error(sensitive),
  });
  const { engine } = fixture({
    async initialize() {
      throw failure;
    },
  });
  const events = [];
  const client = createMavio({
    engine,
    onDiagnostic: (event) => events.push(event),
  });

  try {
    await assert.rejects(client.capabilities(), { code: "ENGINE_UNAVAILABLE" });
    await flush();

    const errors = events.filter((event) => event.type === "job-error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "ENGINE_UNAVAILABLE");
    assert.deepEqual(Object.keys(errors[0]).sort(), [
      "code",
      "engineId",
      "jobId",
      "runtime",
      "stage",
      "type",
    ]);
    assert.equal(JSON.stringify(events).includes(sensitive), false);
    assert.deepEqual(
      events.filter((event) => event.type === "job-progress").map((event) => event.stage),
      ["queued", "preparing", "failed"],
    );
  } finally {
    await client.dispose();
  }
});

for (const behavior of ["throw", "reject", "never-settle"]) {
  test(
    `diagnostic observers cannot fail or delay jobs: ${behavior}`,
    { timeout: 2000 },
    async () => {
      const { engine } = fixture();
      const progress = [];
      let observed = 0;
      const client = createMavio({
        engine,
        onDiagnostic() {
          observed++;
          if (behavior === "throw") throw new Error("Observer failure.");
          if (behavior === "reject") return Promise.reject(new Error("Observer failure."));
          return new Promise(() => {});
        },
      });

      try {
        const inventory = await client.capabilities({
          onProgress: (event) => progress.push(event),
        });
        await flush();
        assert.equal(inventory.runtime, "node");
        assert.equal(observed, 5);
        assert.equal(progress.at(-1).stage, "completed");
      } finally {
        await client.dispose();
      }
    },
  );
}

test("pre-aborted requests emit no admitted-job diagnostics", async () => {
  const { engine, calls } = fixture();
  const events = [];
  const client = createMavio({
    engine,
    onDiagnostic: (event) => events.push(event),
  });
  const controller = new AbortController();
  controller.abort();

  try {
    await assert.rejects(client.capabilities({ signal: controller.signal }), { code: "CANCELLED" });
    await flush();
    assert.deepEqual(events, []);
    assert.deepEqual(calls, []);
  } finally {
    await client.dispose();
  }
});

for (const action of ["cancel", "dispose"]) {
  test(
    `diagnostic-triggered lifecycle actions preserve job outcomes: ${action}`,
    { timeout: 2000 },
    async () => {
      const { engine } = fixture();
      const controller = new AbortController();
      const events = [];
      let acted = false;
      let disposal;
      const client = createMavio({
        engine,
        onDiagnostic(event) {
          events.push(event);

          if (!acted && event.type === "job-progress" && event.stage === "queued") {
            acted = true;
            if (action === "cancel") controller.abort();
            else disposal = client.dispose();
          }
        },
      });

      try {
        await assert.rejects(client.capabilities({ signal: controller.signal }), {
          code: "CANCELLED",
        });
        if (disposal) await disposal;
        await flush();

        assert.equal(acted, true);
        const jobId = events[0].jobId;
        const terminal = events.filter(
          (event) =>
            event.type === "job-progress" &&
            event.jobId === jobId &&
            ["completed", "failed", "cancelled"].includes(event.stage),
        );
        assert.deepEqual(
          terminal.map((event) => event.stage),
          ["cancelled"],
        );

        const errors = events.filter(
          (event) => event.type === "job-error" && event.jobId === jobId,
        );
        assert.equal(errors.length, 1);
        assert.equal(errors[0].code, "CANCELLED");

        if (action === "cancel") {
          const recovered = await client.capabilities();
          assert.equal(recovered.runtime, "node");
        } else {
          await assert.rejects(client.capabilities(), { code: "DISPOSED" });
        }
      } finally {
        await client.dispose();
      }
    },
  );
}
