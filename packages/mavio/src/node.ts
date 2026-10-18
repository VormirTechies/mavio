import { createFactory } from "./core/factory.js";
import { createMavioError } from "./core/errors.js";
import { createNativeEngine } from "./engines/native/adapter.js";
import { createNodeRuntime } from "./runtime/node.js";

export { SDK_VERSION } from "./index.js";
export type * from "./contracts.js";

export const createMavio = createFactory(createNodeRuntime, (options) => {
  if (options.browser !== undefined) {
    throw createMavioError(
      "INVALID_OPTIONS",
      "Browser engine options cannot configure the Node native engine.",
    );
  }

  return createNativeEngine(options.native);
});
