import assert from "node:assert/strict";
import test from "node:test";
import { captureInput } from "../../dist/core/input.js";

test("malformed inputs fail before job admission", () => {
  const cases = [
    [null, "INVALID_SHAPE"],
    [undefined, "INVALID_SHAPE"],
    ["video.mp4", "INVALID_SHAPE"],
    [[], "INVALID_SHAPE"],
    [{}, "INVALID_KIND"],
    [{ kind: "url" }, "INVALID_KIND"],
    [{ kind: "bytes", bytes: [1] }, "INVALID_BYTES"],
    [{ kind: "bytes", bytes: new Uint8Array() }, "EMPTY_BYTES"],
    [{ kind: "bytes", bytes: new Uint8Array([1]), name: 42 }, "INVALID_NAME"],
    [{ kind: "blob", blob: { size: 10 } }, "INVALID_BLOB"],
    [{ kind: "blob", blob: new Blob([]) }, "EMPTY_BLOB"],
    [{ kind: "path", path: 42 }, "INVALID_PATH"],
    [{ kind: "path", path: "" }, "EMPTY_PATH"],
    [{ kind: "path", path: "bad\0.mp4" }, "INVALID_PATH"],
  ];

  for (const [input, reason] of cases) {
    assert.throws(
      () => captureInput(input),
      (error) => {
        assert.equal(error.code, "INVALID_INPUT");
        assert.equal(error.stage, "queued");
        assert.equal(error.jobId, undefined);
        assert.equal(error.details.reason, reason);
        return true;
      },
    );
  }
});

test("captures byte descriptors without copying or detaching caller bytes", () => {
  const storage = new Uint8Array([9, 1, 2, 9]);
  const bytes = storage.subarray(1, 3);
  const input = { kind: "bytes", bytes, name: "sample.mp4" };

  const captured = captureInput(input);

  input.bytes = new Uint8Array([7]);
  input.name = "changed.mp4";

  assert.equal(captured.bytes, bytes);
  assert.equal(captured.bytes.buffer, storage.buffer);
  assert.deepEqual([...captured.bytes], [1, 2]);
  assert.equal(captured.name, "sample.mp4");
  assert.equal(storage.byteLength, 4);
  assert.ok(Object.isFrozen(captured));
});

test("captures an immutable Blob reference", () => {
  const blob = new Blob(["sample"]);
  const input = { kind: "blob", blob };
  const captured = captureInput(input);

  input.blob = new Blob(["replacement"]);

  assert.equal(captured.blob, blob);
  assert.ok(Object.isFrozen(captured));
});

test("captures paths without trimming or checking file existence", () => {
  const original = " relative folder/missing.mp4 ";
  const input = { kind: "path", path: original };
  const captured = captureInput(input);

  input.path = "different.mp4";

  assert.equal(captured.path, original);
  assert.ok(Object.isFrozen(captured));
});
