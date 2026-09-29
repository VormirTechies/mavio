import assert from "node:assert/strict";
import test from "node:test";
import { SerialQueue } from "../../dist/core/queue.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("invalid queue limits fail synchronously", () => {
  for (const limit of [-1, 1.5, NaN, Infinity, "2", null]) {
    assert.throws(
      () => new SerialQueue(limit),
      (error) => {
        assert.equal(error.code, "INVALID_OPTIONS");
        assert.equal(error.stage, "queued");
        assert.equal(error.jobId, undefined);
        assert.equal(error.details.reason, "INVALID_QUEUE_LIMIT");
        return true;
      },
    );
  }
});

test("tasks run in FIFO order without overlap", async () => {
  const queue = new SerialQueue();
  const gate = deferred();
  const order = [];
  let active = 0;
  let peak = 0;

  const submit = (id) =>
    queue.submit(async () => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(`start-${id}`);

      try {
        if (id === 1) await gate.promise;
        order.push(`end-${id}`);
        return id;
      } finally {
        active -= 1;
      }
    });

  const jobs = [submit(1), submit(2), submit(3)];

  assert.deepEqual(order, ["start-1"]);
  gate.resolve();

  assert.deepEqual(await Promise.all(jobs), [1, 2, 3]);
  assert.equal(peak, 1);
  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
});

test("capacity excludes the active task and defaults to sixteen waiting tasks", async () => {
  for (const limit of [1, 16]) {
    const queue = limit === 16 ? new SerialQueue() : new SerialQueue(limit);
    const gate = deferred();
    const jobs = [queue.submit(() => gate.promise)];

    for (let index = 0; index < limit; index += 1) {
      jobs.push(queue.submit(() => index));
    }

    let overflowRan = false;
    await assert.rejects(
      queue.submit(() => {
        overflowRan = true;
      }),
      (error) => {
        assert.equal(error.code, "QUEUE_FULL");
        assert.equal(error.stage, "queued");
        assert.equal(error.jobId, undefined);
        return true;
      },
    );

    assert.equal(overflowRan, false);
    gate.resolve();
    await Promise.all(jobs);
  }
});

test("zero queue capacity accepts only idle work and becomes reusable", async () => {
  const queue = new SerialQueue(0);
  const gate = deferred();
  const first = queue.submit(() => gate.promise);

  await assert.rejects(
    queue.submit(() => "blocked"),
    {
      code: "QUEUE_FULL",
    },
  );

  gate.resolve("first");
  assert.equal(await first, "first");
  assert.equal(await queue.submit(() => "next"), "next");
});

test("async rejection and synchronous throws do not strand waiting tasks", async () => {
  const queue = new SerialQueue();
  const gate = deferred();
  const asyncFailure = new Error("Async failure");
  const syncFailure = new Error("Sync failure");

  const first = queue.submit(async () => {
    await gate.promise;
    throw asyncFailure;
  });
  const second = queue.submit(() => {
    throw syncFailure;
  });
  const third = queue.submit(() => "recovered");

  // Attach rejection handlers before releasing the first task.
  const settled = Promise.allSettled([first, second, third]);
  gate.resolve();

  assert.deepEqual(await settled, [
    { status: "rejected", reason: asyncFailure },
    { status: "rejected", reason: syncFailure },
    { status: "fulfilled", value: "recovered" },
  ]);
});

test("separate queues execute independently", async () => {
  const firstQueue = new SerialQueue();
  const secondQueue = new SerialQueue();
  const gate = deferred();
  const started = [];

  const first = firstQueue.submit(async () => {
    started.push("first");
    await gate.promise;
  });

  const second = secondQueue.submit(() => {
    started.push("second");
    return "done";
  });

  assert.equal(await second, "done");
  assert.deepEqual(started, ["first", "second"]);

  gate.resolve();
  await first;
});

test("pre-aborted submissions beat queue-full errors without starting work", async () => {
  const queue = new SerialQueue(0);
  const gate = deferred();
  const active = queue.submit(() => gate.promise);
  const controller = new AbortController();
  controller.abort();

  let started = false;

  await assert.rejects(
    queue.submit(() => {
      started = true;
    }, controller.signal),
    { code: "CANCELLED" },
  );

  assert.equal(started, false);
  gate.resolve();
  await active;
});

test("queued cancellation frees capacity and preserves survivor order", async () => {
  const queue = new SerialQueue(2);
  const gate = deferred();
  const controller = new AbortController();
  const order = [];

  const active = queue.submit(() => gate.promise);
  const cancelled = queue.submit(() => {
    order.push("cancelled");
  }, controller.signal);
  const survivor = queue.submit(() => {
    order.push("survivor");
  });

  const rejection = assert.rejects(cancelled, {
    code: "CANCELLED",
    stage: "queued",
  });

  controller.abort();
  await rejection;

  const replacement = queue.submit(() => {
    order.push("replacement");
  });

  gate.resolve();
  await Promise.all([active, survivor, replacement]);

  assert.deepEqual(order, ["survivor", "replacement"]);
});

test("active cancellation retains the slot until cleanup completes", async () => {
  const queue = new SerialQueue();
  const controller = new AbortController();
  const aborted = deferred();
  const cleanup = deferred();
  const order = [];

  const active = queue.submit(async (signal) => {
    signal.addEventListener(
      "abort",
      () => {
        order.push("abort");
        aborted.resolve();
      },
      { once: true },
    );

    await aborted.promise;
    await cleanup.promise;
    order.push("cleaned");
    return "discarded";
  }, controller.signal);

  let settled = false;
  const rejection = assert.rejects(active, { code: "CANCELLED" });
  const observed = active.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  const next = queue.submit(() => {
    order.push("next");
  });

  controller.abort();
  await aborted.promise;

  assert.equal(settled, false);
  assert.deepEqual(order, ["abort"]);

  cleanup.resolve();
  await Promise.all([rejection, observed, next]);

  assert.deepEqual(order, ["abort", "cleaned", "next"]);
});

test("cancellation preserves a task rejection as its diagnostic cause", async () => {
  const queue = new SerialQueue();
  const controller = new AbortController();
  const aborted = deferred();
  const cause = new Error("Worker stopped after cancellation.");

  const active = queue.submit(async (signal) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    await aborted.promise;
    throw cause;
  }, controller.signal);

  const rejection = assert.rejects(active, (error) => {
    assert.equal(error.code, "CANCELLED");
    assert.equal(error.cause, cause);
    return true;
  });

  controller.abort();
  await rejection;
  assert.equal(await queue.submit(() => "reusable"), "reusable");
});

test("late cancellation does not affect a completed or subsequent task", async () => {
  const queue = new SerialQueue();
  const controller = new AbortController();
  let firstSignal;

  assert.equal(
    await queue.submit((signal) => {
      firstSignal = signal;
      return "complete";
    }, controller.signal),
    "complete",
  );

  controller.abort();

  assert.equal(firstSignal.aborted, false);
  assert.equal(await queue.submit((signal) => signal.aborted), false);
});

test("aborting one active task does not cancel an unrelated waiting task", async () => {
  const queue = new SerialQueue();
  const controller = new AbortController();
  const aborted = deferred();

  const active = queue.submit(async (signal) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    await aborted.promise;
  }, controller.signal);

  const next = queue.submit((signal) => {
    assert.equal(signal.aborted, false);
    return "next completed";
  });

  const rejection = assert.rejects(active, { code: "CANCELLED" });
  controller.abort();

  await rejection;
  assert.equal(await next, "next completed");
});

test("cancellation before the commit gate prevents publication", async () => {
  const queue = new SerialQueue();
  const controller = new AbortController();
  const proceed = deferred();
  let published = false;

  const job = queue.submit(async (signal, beginCommit) => {
    await proceed.promise;

    assert.equal(signal.aborted, true);
    assert.equal(beginCommit(), false);
    if (beginCommit()) published = true;
  }, controller.signal);

  const rejection = assert.rejects(job, { code: "CANCELLED" });

  controller.abort();
  proceed.resolve();

  await rejection;
  assert.equal(published, false);
});

test("cancellation after the gate preserves publication and holds the active slot", async () => {
  const queue = new SerialQueue();
  const controller = new AbortController();
  const publication = deferred();
  const order = [];
  let taskSignal;

  const job = queue.submit(async (signal, beginCommit) => {
    taskSignal = signal;
    assert.equal(beginCommit(), true);
    order.push("authorized");

    await publication.promise;
    order.push("published");
    return "output";
  }, controller.signal);

  const next = queue.submit(() => {
    order.push("next");
  });

  controller.abort();

  assert.equal(taskSignal.aborted, false);
  assert.deepEqual(order, ["authorized"]);

  publication.resolve();

  assert.equal(await job, "output");
  await next;
  assert.deepEqual(order, ["authorized", "published", "next"]);
});

test("publication failure remains a failure after late cancellation", async () => {
  const queue = new SerialQueue();
  const controller = new AbortController();
  const publication = deferred();
  const failure = new Error("Destination became occupied.");

  const job = queue.submit(async (_signal, beginCommit) => {
    assert.equal(beginCommit(), true);
    await publication.promise;
    throw failure;
  }, controller.signal);

  const rejection = assert.rejects(job, (error) => {
    assert.equal(error, failure);
    return true;
  });

  controller.abort();
  publication.resolve();

  await rejection;
  assert.equal(await queue.submit(() => "reusable"), "reusable");
});

test("the commit gate grants permission only once per task", async () => {
  const queue = new SerialQueue();
  let publications = 0;

  await queue.submit((_signal, beginCommit) => {
    if (beginCommit()) publications += 1;
    if (beginCommit()) publications += 1;
  });

  assert.equal(publications, 1);
});

test("a retained commit gate cannot authorize work after task settlement", async () => {
  const queue = new SerialQueue();
  let completedGate;
  let failedGate;

  await queue.submit((_signal, beginCommit) => {
    completedGate = beginCommit;
  });

  await assert.rejects(
    queue.submit((_signal, beginCommit) => {
      failedGate = beginCommit;
      throw new Error("Task failed.");
    }),
    /Task failed/,
  );

  assert.equal(completedGate(), false);
  assert.equal(failedGate(), false);
});

test("idle disposal is permanent and returns the same promise", async () => {
  const queue = new SerialQueue();
  const first = queue.dispose();

  assert.equal(queue.dispose(), first);
  await first;
  assert.equal(queue.dispose(), first);

  await assert.rejects(
    queue.submit(() => "blocked"),
    {
      code: "DISPOSED",
    },
  );
});

test("disposal takes precedence over a pre-aborted submission", async () => {
  const queue = new SerialQueue();
  const controller = new AbortController();
  controller.abort();

  await queue.dispose();

  await assert.rejects(
    queue.submit(() => "blocked", controller.signal),
    { code: "DISPOSED" },
  );
});

test("disposal cancels waiting tasks without starting them", async () => {
  const queue = new SerialQueue();
  const publication = deferred();
  let waitingStarted = false;

  const active = queue.submit(async (_signal, beginCommit) => {
    assert.equal(beginCommit(), true);
    await publication.promise;
    return "published";
  });

  const waiting = queue.submit(() => {
    waitingStarted = true;
  });

  const rejected = assert.rejects(waiting, {
    code: "CANCELLED",
    stage: "queued",
  });

  const disposal = queue.dispose();
  await rejected;

  assert.equal(waitingStarted, false);
  publication.resolve();

  assert.equal(await active, "published");
  await disposal;
});

test("disposal interrupts active work and waits for its cleanup", async () => {
  const queue = new SerialQueue();
  const aborted = deferred();
  const cleanup = deferred();
  let cleanupFinished = false;

  const active = queue.submit(async (signal) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    await aborted.promise;
    await cleanup.promise;
    cleanupFinished = true;
  });

  const rejected = assert.rejects(active, { code: "CANCELLED" });
  const disposal = queue.dispose();

  let disposed = false;
  const observed = disposal.then(() => {
    disposed = true;
  });

  await aborted.promise;
  assert.equal(disposed, false);
  assert.equal(cleanupFinished, false);

  await assert.rejects(
    queue.submit(() => "blocked"),
    {
      code: "DISPOSED",
    },
  );

  cleanup.resolve();
  await Promise.all([rejected, observed]);

  assert.equal(cleanupFinished, true);
  assert.equal(disposed, true);
});

test("disposal waits for authorized publication without aborting it", async () => {
  const queue = new SerialQueue();
  const publication = deferred();
  let taskSignal;

  const active = queue.submit(async (signal, beginCommit) => {
    taskSignal = signal;
    assert.equal(beginCommit(), true);
    await publication.promise;
    return "output";
  });

  const disposal = queue.dispose();
  let disposed = false;
  const observed = disposal.then(() => {
    disposed = true;
  });

  await Promise.resolve();

  assert.equal(disposed, false);
  assert.equal(taskSignal.aborted, false);
  assert.equal(queue.dispose(), disposal);

  publication.resolve();

  assert.equal(await active, "output");
  await observed;
  assert.equal(disposed, true);
});

test("reentrant disposal from an abort listener shares the same promise", async () => {
  const queue = new SerialQueue();
  const aborted = deferred();
  let reentrantDisposal;

  const active = queue.submit(async (signal) => {
    signal.addEventListener(
      "abort",
      () => {
        reentrantDisposal = queue.dispose();
        aborted.resolve();
      },
      { once: true },
    );

    await aborted.promise;
  });

  const rejected = assert.rejects(active, { code: "CANCELLED" });
  const disposal = queue.dispose();

  assert.equal(reentrantDisposal, disposal);
  await Promise.all([rejected, disposal]);
});
