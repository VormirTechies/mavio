import assert from "node:assert/strict";
import test from "node:test";
import { createMavioError } from "../../dist/core/errors.js";

test("pre-admission errors use queued stage without a job ID", () => {
  const error = createMavioError("INVALID_OPTIONS", "Trim start must be a finite number.", {
    operation: "trim",
    details: { reason: "INVALID_START" },
  });

  assert.ok(error instanceof Error);
  assert.equal(error.name, "MavioError");
  assert.equal(error.code, "INVALID_OPTIONS");
  assert.equal(error.stage, "queued");
  assert.equal(error.jobId, undefined);
  assert.equal(error.operation, "trim");
  assert.equal(error.details.reason, "INVALID_START");
});

test("cleanup diagnostics preserve the primary failure and its cause", () => {
  const cause = new Error("Engine execution stopped.");
  const details = { reason: "ENGINE_FAILURE" };
  const cleanupIssues = ["Temporary output could not be removed."];

  const error = createMavioError("EXECUTION_FAILED", "Media processing failed.", {
    stage: "running",
    jobId: "test-job-1",
    engineId: "mock",
    details,
    cleanupIssues,
    cause,
  });

  details.reason = "CHANGED";
  cleanupIssues.push("Added after error creation.");

  assert.equal(error.code, "EXECUTION_FAILED");
  assert.equal(error.stage, "running");
  assert.equal(error.jobId, "test-job-1");
  assert.equal(error.engineId, "mock");
  assert.equal(error.cause, cause);
  assert.deepEqual(error.details, { reason: "ENGINE_FAILURE" });
  assert.deepEqual(error.cleanupIssues, ["Temporary output could not be removed."]);
  assert.ok(Object.isFrozen(error.details));
  assert.ok(Object.isFrozen(error.cleanupIssues));
});
