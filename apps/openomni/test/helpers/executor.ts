import { createExecutor } from "@openomni/agent";
import { LedgerAction } from "@openomni/protocol";
import { fixtureHashes } from "../../../../packages/agent/test/helpers/compiled-policy";
import { nullRetryAlarm } from "../../../../packages/agent/test/helpers/retry-alarm";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "../../../../packages/policy/src";

let ordinal = 0;

/** The seeded policy rows compiled at generation 1: the real snapshot test executors enforce. */
export const seededPolicy = compilePolicySnapshot({
  generation: 1,
  mandatory: [],
  rows: SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
});

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
  // In-memory ledger: durable retry scheduling is covered by the agent package tests.
  retryAlarm: nullRetryAlarm,
  entropy: () => `test-action-${ordinal + 1}`,
});
