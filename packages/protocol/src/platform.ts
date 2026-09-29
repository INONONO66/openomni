import type { EpochMs } from "./time.js";

/** Wall-clock epoch milliseconds supplied by a runtime owner. */
export type Clock = () => EpochMs;

/** Opaque identity supplied by the package that owns its runtime lifecycle. */
export type IdSource = () => string;
