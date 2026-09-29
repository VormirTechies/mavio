import { createFactory } from "./core/factory.js";
import { BROWSER_RUNTIME } from "./core/runtime.js";

export { SDK_VERSION } from "./index.js";
export type * from "./contracts.js";

export const createMavio = createFactory(() => BROWSER_RUNTIME);
