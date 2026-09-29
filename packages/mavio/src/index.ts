import { createFactory } from "./core/factory.js";

export const SDK_VERSION = "0.0.2" as const;

export const createMavio = createFactory();

export type * from "./contracts.js";
