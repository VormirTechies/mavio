import { resolve, sep } from "node:path";
import { cwd } from "node:process";
import type { RuntimeContext } from "../core/runtime.js";

export function createNodeRuntime(): RuntimeContext {
  const baseDirectory = cwd();

  return Object.freeze({
    runtime: "node",

    resolvePath(value: string): string {
      if (sep === "\\" && /^[a-zA-Z]:(?![\\/])/.test(value)) {
        throw new Error("Drive-relative paths are ambiguous. Use an absolute path instead.");
      }

      return resolve(baseDirectory, value);
    },
  });
}
