import assert from "node:assert/strict";
import test from "node:test";
import { prepareBrowserInput } from "../../dist/engines/browser/input.js";

function context(controller = new AbortController()) {
  return {
    jobId: "browser-input-test",
    signal: controller.signal,
    reportProgress() {},
  };
}

function deferred() {
  let resolve;
  let reject;

  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });

  return { promise, resolve, reject };
}

test("browser byte preparation copies only the visible input view", async () => {
  const backing = new Uint8Array([99, 1, 2, 3, 88]);
  const input = backing.subarray(1, 4);

  const owned = await prepareBrowserInput({ kind: "bytes", bytes: input }, context());

  assert.deepEqual(Array.from(owned), [1, 2, 3]);
  assert.notEqual(owned.buffer, input.buffer);
  assert.equal(owned.byteOffset, 0);
  assert.equal(owned.buffer.byteLength, 3);

  owned[0] = 42;
  assert.deepEqual(Array.from(backing), [99, 1, 2, 3, 88]);
});

test("transferring prepared bytes does not detach caller bytes", async () => {
  const input = new Uint8Array([4, 5, 6]);

  const owned = await prepareBrowserInput({ kind: "bytes", bytes: input }, context());

  const transferred = structuredClone(owned, {
    transfer: [owned.buffer],
  });

  assert.equal(owned.byteLength, 0);
  assert.deepEqual(Array.from(transferred), [4, 5, 6]);
  assert.deepEqual(Array.from(input), [4, 5, 6]);
});

test("Buffer inputs are copied rather than sliced into shared storage", async () => {
  const input = Buffer.from([7, 8, 9]);

  const owned = await prepareBrowserInput({ kind: "bytes", bytes: input }, context());

  owned[1] = 42;

  assert.equal(Buffer.isBuffer(owned), false);
  assert.deepEqual(Array.from(input), [7, 8, 9]);
});

test("Blob and File inputs yield transferable bytes without changing the source", async () => {
  const content = new Uint8Array([10, 20, 30]);

  for (const blob of [
    new Blob([content]),
    new File([content], "fixture.wav", { type: "audio/wav" }),
  ]) {
    const owned = await prepareBrowserInput({ kind: "blob", blob }, context());

    const transferred = structuredClone(owned, {
      transfer: [owned.buffer],
    });

    assert.deepEqual(Array.from(transferred), [10, 20, 30]);
    assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [10, 20, 30]);
  }
});

test("pre-aborted preparation never starts a Blob read", async () => {
  const controller = new AbortController();
  controller.abort();

  let reads = 0;

  await assert.rejects(
    prepareBrowserInput(
      { kind: "blob", blob: new Blob(["media"]) },
      context(controller),
      async () => {
        reads += 1;
        return new ArrayBuffer(5);
      },
    ),
    { code: "CANCELLED", stage: "preparing" },
  );

  assert.equal(reads, 0);
});

test("cancellation settles pending Blob preparation and observes a late failure", async () => {
  const controller = new AbortController();
  const entered = deferred();
  const reading = deferred();

  const pending = prepareBrowserInput(
    { kind: "blob", blob: new Blob(["media"]) },
    context(controller),
    () => {
      entered.resolve();
      return reading.promise;
    },
  );

  const rejected = assert.rejects(pending, {
    code: "CANCELLED",
    jobId: "browser-input-test",
  });

  await entered.promise;
  controller.abort();
  await rejected;

  // The race must retain a rejection handler for the abandoned read.
  reading.reject(new Error("Late Blob read failure."));
  await new Promise((resolve) => setImmediate(resolve));
});

test("Blob read errors retain their cause and inconsistent reads reject", async () => {
  const blob = new Blob(["media"]);
  const failure = new Error("Simulated read failure.");

  await assert.rejects(
    prepareBrowserInput({ kind: "blob", blob }, context(), async () => {
      throw failure;
    }),
    (error) => {
      assert.equal(error.code, "IO_ERROR");
      assert.equal(error.cause, failure);
      return true;
    },
  );

  await assert.rejects(
    prepareBrowserInput({ kind: "blob", blob }, context(), async () => new ArrayBuffer(1)),
    { code: "IO_ERROR" },
  );
});

test("browser input preparation rejects paths and empty media", async () => {
  await assert.rejects(prepareBrowserInput({ kind: "path", path: "fixture.wav" }, context()), {
    code: "UNSUPPORTED_CAPABILITY",
  });

  for (const input of [
    { kind: "bytes", bytes: new Uint8Array() },
    { kind: "blob", blob: new Blob() },
  ]) {
    await assert.rejects(prepareBrowserInput(input, context()), { code: "INVALID_INPUT" });
  }
});
