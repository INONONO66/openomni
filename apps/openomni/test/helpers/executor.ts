import { createExecutor } from "@openomni/agent";
import { LedgerAction } from "@openomni/protocol";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "../../../../packages/policy/src";

let ordinal = 0;

/** The seeded policy rows compiled at generation 1: the real snapshot test executors enforce. */
export const seededPolicy = compilePolicySnapshot({
  generation: 1,
  mandatory: [],
  rows: SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
});

/** Fixture chain links: tests here assert executor behaviour, not the ledger's hash owner. */
export function fixtureHashes(ordinal: number) {
  return { prevHash: `fixture-hash-${ordinal - 1}`, actionHash: `fixture-hash-${ordinal}` };
}

/** Production executor composition with deterministic in-memory receipts. */
export const executor = createExecutor({
  policy: seededPolicy,
  ledger: {
    async commit(action) {
      ordinal += 1;
      return {
        action: LedgerAction.Node.parse({ ...action, ordinal, ...fixtureHashes(ordinal) }),
        revision: ordinal,
      };
    },
  },
  observations: { publish: () => undefined },
  identity: { sessionId: "test", role: "resident", parentActionId: null },
  clock: () => 1,
  entropy: () => `test-action-${ordinal + 1}`,
});
