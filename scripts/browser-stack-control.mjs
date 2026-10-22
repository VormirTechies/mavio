import assert from "node:assert/strict";

// Observe the native stack around the original bindings without changing their
// bodies, arguments, return values, or the stack pointer. This is test-only.
export function instrumentCoreStack(bytes) {
  let source = bytes.toString("utf8");
  for (const method of ["exec", "ffprobe"]) {
    const marker = `Module["${method}"]=${method};`;
    assert.equal(source.split(marker).length, 2, `Expected one ${method} export.`);
    source = source.replace(
      marker,
      `Module["${method}"]=function(...args){const before=stackSave();const result=${method}(...args);print("MAVIO_STACK_STATE "+JSON.stringify({method:"${method}",before,after:stackSave(),exitCode:result}));return result};`,
    );
  }
  return Buffer.from(source);
}

export function assertStackControl(stdout, corrected) {
  const lines = stdout
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.startsWith("MAVIO_STACK_CONTROL_RESULT ") || line.startsWith("MAVIO_REPLAY_RESULT "),
    );
  const last = lines.at(-1);
  assert.ok(last?.startsWith("MAVIO_STACK_CONTROL_RESULT "), "Missing final stack-control result.");
  const result = JSON.parse(last.slice("MAVIO_STACK_CONTROL_RESULT ".length));
  assert.equal(result.mode, "STACK_CONTROL");
  assert.equal(result.observations.length, 2);
  assert.deepEqual(
    result.observations.map((item) => item.method),
    ["exec", "ffprobe"],
  );
  for (const item of result.observations) {
    assert.ok(Number.isSafeInteger(item.before) && item.before > 0);
    assert.ok(Number.isSafeInteger(item.after) && item.after > 0);
    assert.equal(item.exitCode, 0, `${item.method} -version must complete successfully.`);
    if (corrected) assert.equal(item.after, item.before, `${item.method} must restore its stack.`);
    else assert.ok(item.after < item.before, `${item.method} control must demonstrate stack loss.`);
  }
  assert.equal(
    result.observations[1].before,
    result.observations[0].after,
    "The second command must start at the preceding stack position.",
  );
  return result;
}
