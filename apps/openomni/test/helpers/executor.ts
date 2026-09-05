import { createExecutor } from "@openomni/agent";
import { LedgerAction } from "@openomni/protocol";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "../../../../packages/policy/src";

let ordinal = 0;

/** Production executor composition with deterministic in-memory receipts. */
export const executor = createExecutor({
  policy: compilePolicySnapshot({
    generation: 1,
    mandatory: [],
    rows: SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
  }),
  ledger: {
    async commit(action) {
      ordinal += 1;
      return { action: LedgerAction.Node.parse({ ...action, ordinal }), revision: ordinal };
    },
  },
  observations: { publish: () => undefined },
  identity: { sessionId: "test", role: "resident", parentActionId: null },
  clock: () => 1,
  entropy: () => `test-action-${ordinal + 1}`,
});
