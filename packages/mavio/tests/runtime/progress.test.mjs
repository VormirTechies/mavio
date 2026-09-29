import assert from "node:assert/strict";
import test from "node:test";
import { allocateJobId, createProgress } from "../../dist/core/progress.js";

test("allocated IDs are unique across tracker instances", () => {
  const ids = Array.from({ length: 100 }, () => allocateJobId());
  assert.equal(new Set(ids).size, ids.length);
});

test("progress delivers ordered immutable stages and one terminal event", () => {
  const events = [];
  const tracker = createProgress({
    jobId: "job-1",
    engineId: "mock",
    onProgress: (event) => events.push(event),
  });

  tracker.report("running");
  tracker.report("completed");
  tracker.report("failed");
  tracker.report("running", 50);

  assert.deepEqual(
    events.map((event) => event.stage),
    ["queued", "preparing", "running", "finalizing", "completed"],
  );

  for (const event of events) {
    assert.ok(Object.isFrozen(event));
    assert.equal(event.jobId, "job-1");
    assert.equal(event.engineId, "mock");
  }

  assert.equal(events[0].percent, undefined);
  assert.equal(events.at(-1).percent, 100);
});

test("percentages never decrease or reach 100 before completion", () => {
  let time = 0;
  const events = [];
  const tracker = createProgress({
    jobId: "job-2",
    now: () => time,
    onProgress: (event) => events.push(event),
  });

  tracker.report("running", 20);

  for (const percent of [10, -1, NaN, Infinity, 100, 101]) {
    time += 100;
    tracker.report("running", percent);
  }

  time += 100;
  tracker.report("running", 40);
  tracker.report("failed");

  assert.deepEqual(
    events.filter((event) => event.percent !== undefined).map((event) => event.percent),
    [20, 40, 40],
  );
  assert.equal(events.at(-1).stage, "failed");
});

test("percent-only updates are throttled while stage transitions are immediate", () => {
  let time = 0;
  const events = [];
  const tracker = createProgress({
    jobId: "job-3",
    now: () => time,
    onProgress: (event) => events.push(event),
  });

  tracker.report("running", 0);

  time = 50;
  tracker.report("running", 10);

  time = 100;
  tracker.report("running", 20);

  time = 101;
  tracker.report("finalizing", 30);
  tracker.report("completed");

  assert.deepEqual(
    events.filter((event) => event.percent !== undefined).map((event) => event.percent),
    [0, 20, 30, 100],
  );
});

test("synchronous and asynchronous observer failures are isolated", async () => {
  for (const observer of [
    () => {
      throw new Error("Observer failed.");
    },
    () => Promise.reject(new Error("Async observer failed.")),
  ]) {
    const tracker = createProgress({
      jobId: "observer-test",
      onProgress: observer,
    });

    assert.doesNotThrow(() => tracker.report("completed"));
  }

  // Allow rejected observer promises and their handlers to settle.
  await new Promise((resolve) => setImmediate(resolve));
});

test("reentrant cancellation stops further stage delivery", () => {
  const events = [];
  let tracker;

  tracker = createProgress({
    jobId: "job-4",
    onProgress: (event) => {
      events.push(event);
      if (event.stage === "preparing") {
        tracker.report("cancelled");
      }
    },
  });

  tracker.report("running");
  tracker.report("completed");

  assert.deepEqual(
    events.map((event) => event.stage),
    ["queued", "preparing", "cancelled"],
  );
  assert.equal(events.at(-1).percent, undefined);
});

test("reentrant progress cannot lower a percentage during stage advancement", () => {
  const events = [];
  let tracker;

  tracker = createProgress({
    jobId: "reentrant-percent",
    now: () => 1000,
    onProgress: (event) => {
      events.push(event);

      if (event.stage === "preparing") {
        tracker.report("running", 80);
      }
    },
  });

  tracker.report("finalizing", 20);
  tracker.report("completed");

  assert.deepEqual(
    events.map((event) => [event.stage, event.percent]),
    [
      ["queued", undefined],
      ["preparing", undefined],
      ["running", 80],
      ["finalizing", 80],
      ["completed", 100],
    ],
  );
});
