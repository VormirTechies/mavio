import { createFactory } from "./core/factory.js";
import { createMavioError } from "./core/errors.js";
import { BROWSER_RUNTIME } from "./core/runtime.js";
import { createBrowserEngine } from "./engines/browser/adapter.js";

export { SDK_VERSION } from "./index.js";
export type * from "./contracts.js";

export const createMavio = createFactory(
  () => BROWSER_RUNTIME,
  (options) => {
    if (options.native !== undefined) {
      throw createMavioError(
        "INVALID_OPTIONS",
        "Native engine options cannot configure the browser engine.",
      );
    }

    if (options.browser === undefined) {
      throw createMavioError("INVALID_OPTIONS", "Browser engine assets are required.");
    }

    return createBrowserEngine(options.browser);
  },
);
