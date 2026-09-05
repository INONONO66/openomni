import { compilePolicySnapshot, type CompiledPolicySnapshot } from "@openomni/policy";
import { LedgerAction } from "@openomni/protocol";

/**
 * An "allow everything" compiled policy for tests. The compiler fails closed on
 * a generation missing its mandatory rules, so the snapshot still carries the
 * mandatory compaction row; with no denying rule every unmatched core action
 * defaults to allow.
 */
export const allowAllPolicy: CompiledPolicySnapshot = compilePolicySnapshot({
  generation: 1,
  mandatory: [],
  rows: [
    {
      name: "compaction",
      kind: "turn",
      phase: "post",
      match: { encodingVersion: 1, value: { op: "compaction" } },
      verdict: { encodingVersion: 1, value: { type: "allow" } },
      priority: 1000,
      generation: 1,
    },
  ],
});

/**
 * The executor carries `op` and `phase` inside the intent/effect payload
 * (executor.ts writes `{ phase, op, value }`), not as top-level node fields.
 */
export function opPhaseOf(action: LedgerAction.Append): string {
  for (const carrier of [action.intent?.value, action.effect?.value]) {
    if (carrier === null || typeof carrier !== "object" || Array.isArray(carrier)) continue;
    const { op, phase } = carrier;
    if (typeof op === "string" && typeof phase === "string") return `${op}:${phase}`;
  }
  return "unknown";
}

/**
 * An in-memory ExecutionLedger that records every append and mints ordinals;
 * `entropy` yields the id the next commit will carry so tests stay deterministic.
 */
export function recordingLedger(committed: LedgerAction.Append[] = []) {
  let ordinal = 0;
  return {
    committed,
    entropy: () => `action-${ordinal + 1}`,
    ledger: {
      async commit(action: LedgerAction.Append): Promise<LedgerAction.Receipt> {
        committed.push(action);
        ordinal += 1;
        return { action: LedgerAction.Node.parse({ ...action, ordinal }), revision: ordinal };
      },
    },
  };
}
