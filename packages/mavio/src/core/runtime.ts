import type { MediaInput, OutputTarget, ProcessingPlan, Runtime } from "../contracts.js";
import { createMavioError } from "./errors.js";

export interface RuntimeContext {
  readonly runtime: Runtime;
  readonly resolvePath?: (path: string) => string;
}

export const BROWSER_RUNTIME: RuntimeContext = Object.freeze({
  runtime: "browser",
});

function resolvePath(path: string, environment: RuntimeContext, role: "input" | "output"): string {
  if (environment.runtime !== "node") {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "Filesystem paths are unavailable in the browser runtime.",
      { details: { reason: "UNSUPPORTED_PATH", role } },
    );
  }

  if (environment.resolvePath === undefined) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "The Node runtime path resolver is unavailable.",
      { details: { reason: "PATH_RESOLVER_REQUIRED", role } },
    );
  }

  try {
    const resolved = environment.resolvePath(path);

    if (typeof resolved !== "string" || resolved.length === 0 || resolved.includes("\0")) {
      throw new Error("Invalid resolved path.");
    }

    return resolved;
  } catch (cause) {
    throw createMavioError(
      role === "input" ? "INVALID_INPUT" : "INVALID_OPTIONS",
      "Path could not be resolved. Use an absolute or ordinary relative path.",
      {
        details: { reason: "INVALID_PATH", role },
        cause,
      },
    );
  }
}

export function resolveMediaInput(input: MediaInput, environment: RuntimeContext): MediaInput {
  if (input.kind !== "path") return input;

  return Object.freeze({
    kind: "path",
    path: resolvePath(input.path, environment, "input"),
  });
}

export function resolveProcessingPlan(
  plan: ProcessingPlan,
  environment: RuntimeContext,
): ProcessingPlan {
  const input = resolveMediaInput(plan.input, environment);
  const output: OutputTarget =
    plan.output.kind === "path"
      ? Object.freeze({
          kind: "path",
          path: resolvePath(plan.output.path, environment, "output"),
        })
      : plan.output;

  return Object.freeze({ ...plan, input, output });
}
