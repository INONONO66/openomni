/**
 * The sidebar's attention-ordering engine.
 *
 * Pure TypeScript: no React, no I/O, no clock. `now` is always injected, so the
 * same signals produce the same order in a test, in a render, and in a replay.
 *
 * The rule it encodes: order is never a property of the data and never plain
 * recency. It is a ranking of what the Owner's attention is owed, and every
 * position it assigns comes with a sentence explaining itself.
 */
export type { Boundary, Held } from "./stability";
export { applyAtBoundary, IDLE_BOUNDARY_MS, idleBoundaryReached } from "./stability";
export type { Ordered, ProjectSessionFacts } from "./order";
export { changedSince, orderByAttention } from "./order";
export { reasonFor } from "./reason";
export type { Signals } from "./score";
export { CLASS_RANK, classify, score } from "./score";
