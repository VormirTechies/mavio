import { createFactory } from "./core/factory.js";
import { createNodeRuntime } from "./runtime/node.js";

export { SDK_VERSION } from "./index.js";
export type * from "./contracts.js";

export const createMavio = createFactory(createNodeRuntime);
