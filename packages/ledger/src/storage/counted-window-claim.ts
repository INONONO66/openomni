export type CountedWindowClaimResult = "claimed" | "refused";

/**
 * Atomically claims one item against a counted window.
 *
 * The caller owns the persisted row and window projection; this primitive owns
 * the indivisible read/decision/append sequence. `alreadyClaimed` makes retrying
 * a deterministic claim idempotent without charging the window twice.
 */
export function claimWithinCountedWindow<State>(operations: {
  transaction<T>(operation: () => T): T;
  alreadyClaimed(): boolean;
  readWindowState(): State;
  canClaim(state: State): boolean;
  append(): void;
}): CountedWindowClaimResult {
  return operations.transaction(() => {
    if (operations.alreadyClaimed()) return "claimed";
    const state = operations.readWindowState();
    if (!operations.canClaim(state)) return "refused";
    operations.append();
    return "claimed";
  });
}
