/**
 * The sidebar's attention-ordering engine.
 *
 * Pure TypeScript: no React, no I/O, no clock. The same facts produce the same
 * order in a test, in a render, and in a replay.
 *
 * The rule it encodes: order is never a property of the data. It is a ranking
 * of what the Owner's attention is owed — today from the one fact a session
 * carries, its creation — and it is adopted only at a focus boundary, so the
 * list never reflows under the cursor.
 */
export type { Boundary, Held } from "./stability";
export { applyAtBoundary, IDLE_BOUNDARY_MS, idleBoundaryReached } from "./stability";
export type { Ordered } from "./order";
export { ATTENTION_LABEL, changedSince, orderByAttention } from "./order";
