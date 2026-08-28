/**
 * Canonical deadline semantics for protocol and kernel folds.
 *
 * Deadlines are inclusive: an operation is expired when `now >= deadline`.
 * Therefore work or replies arriving at the exact deadline are late. This
 * matches delegation settlement, whose `no_response` terminal is valid at the
 * deadline, and prevents scheduler ordering from producing two outcomes at
 * the same instant.
 */
export namespace Deadline {
  /** Whether the deadline has been reached or passed. */
  export function isExpired(now: number, deadline: number): boolean {
    return now >= deadline;
  }

  /** Clamp a requested deadline to the authority inherited from its parent. */
  export function clampToParent(requested: number, parent: number): number {
    return Math.min(parent, requested);
  }
}
