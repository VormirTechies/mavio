import type { EngineAdapter, MavioClient, MavioOptions } from "../contracts.js";
import { createCapabilityClient } from "./capability-client.js";
import { createMavioError } from "./errors.js";
import { validateInitTimeout } from "./initialization.js";
import type { RuntimeContext } from "./runtime.js";

const ownedEngines = new WeakSet<EngineAdapter>();

const requiredMethods = [
  "initialize",
  "capabilities",
  "probe",
  "supports",
  "execute",
  "dispose",
] as const;

function validateAdapter(value: unknown): asserts value is EngineAdapter {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw createMavioError("INVALID_OPTIONS", "engine must be an EngineAdapter.");
  }

  const adapter = value as Record<string, unknown>;

  if (typeof adapter.id !== "string" || adapter.id.trim().length === 0) {
    throw createMavioError("INVALID_OPTIONS", "Engine adapter id must be a non-empty string.");
  }

  if (adapter.runtime !== "node" && adapter.runtime !== "browser") {
    throw createMavioError("INVALID_OPTIONS", "Engine adapter runtime must be node or browser.");
  }

  for (const method of requiredMethods) {
    if (typeof adapter[method] !== "function") {
      throw createMavioError("INVALID_OPTIONS", `Engine adapter must implement ${method}().`);
    }
  }
}

export function createFactory(
  runtimeProvider?: () => RuntimeContext,
): (options?: MavioOptions) => MavioClient {
  return function createMavio(options: MavioOptions = {}): MavioClient {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw createMavioError("INVALID_OPTIONS", "Mavio options must be an object.");
    }

    const { engine, native, browser } = options;
    const initTimeoutMs = options.initTimeoutMs === undefined ? 30_000 : options.initTimeoutMs;
    const maxQueuedJobs = options.maxQueuedJobs === undefined ? 16 : options.maxQueuedJobs;

    validateInitTimeout(initTimeoutMs);

    if (
      typeof maxQueuedJobs !== "number" ||
      !Number.isInteger(maxQueuedJobs) ||
      maxQueuedJobs < 0
    ) {
      throw createMavioError("INVALID_OPTIONS", "maxQueuedJobs must be a non-negative integer.");
    }

    if (runtimeProvider === undefined) {
      throw createMavioError(
        "UNSUPPORTED_RUNTIME",
        "Use the @vormir/mavio/node or @vormir/mavio/browser entry point.",
      );
    }

    if (engine === undefined || engine === "auto") {
      throw createMavioError(
        "ENGINE_UNAVAILABLE",
        "Default engines are not implemented yet. Supply an EngineAdapter.",
        { details: { reason: "DEFAULT_ENGINE_NOT_IMPLEMENTED" } },
      );
    }

    validateAdapter(engine);

    if (native !== undefined || browser !== undefined) {
      throw createMavioError(
        "INVALID_OPTIONS",
        "An explicit engine adapter owns its configuration; omit native and browser options.",
      );
    }

    if (ownedEngines.has(engine)) {
      throw createMavioError(
        "INVALID_OPTIONS",
        "This engine adapter already belongs to a client. Create a fresh adapter instance.",
        { details: { reason: "ENGINE_ALREADY_OWNED" } },
      );
    }

    const client = createCapabilityClient(
      engine,
      { initTimeoutMs, maxQueuedJobs },
      runtimeProvider(),
    );

    ownedEngines.add(engine);
    return client;
  };
}
