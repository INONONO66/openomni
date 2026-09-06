import { changedSince, type Ordered } from "./order";

/** Why a held order was allowed to advance. */
export type Boundary = "selection" | "idle" | "refresh";

export interface Held {
  /** The order currently painted. */
  readonly shown: Ordered;
  /** Rows that have moved since `shown` was adopted, as a header hint. */
  readonly pendingChanges: number;
}

/**
 * The stability rule (R06 breakpoint timing).
 *
 * The engine is pure and always knows the ideal order. This decides WHEN the
 * Owner is allowed to see it: never while they are working inside the list.
 * Reordering rows under a moving cursor turns a click into a misclick, and one
 * misclick costs more attention than a stale row ever saves.
 *
 * So a new order is adopted only at a breakpoint — the Owner changed selection,
 * went idle, or asked. Between breakpoints the previous order is held and the
 * drift is reported as a count, which is information without motion.
 */
export function applyAtBoundary(held: Held, ideal: Ordered, boundary: Boundary | null): Held {
  if (boundary === null) {
    return { shown: held.shown, pendingChanges: changedSince(held.shown, ideal) };
  }
  return { shown: ideal, pendingChanges: 0 };
}

/**
 * The idle breakpoint: `userBusy` has been false for long enough that the Owner
 * is reading rather than acting. Two seconds is the spec's figure — long enough
 * that a pause between keystrokes does not count as idle.
 */
export const IDLE_BOUNDARY_MS = 2000;

export function idleBoundaryReached(idleForMs: number): boolean {
  return idleForMs >= IDLE_BOUNDARY_MS;
}
