import { messageDecisionRules } from "./message-decision";
import { createExecutor, Bus } from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import { compilePolicySnapshot } from "@openomni/policy";
import { LedgerAction } from "@openomni/protocol";
import type { createGatewayRouter } from "@openomni/channels";

type Run = Parameters<typeof createGatewayRouter>[0]["run"];

/** External authentication has no active model turn; its message actions have one fenced owner. */
export function createIngressExecutor(clock: () => number): Run {
  const id = "gateway-ingress";
  SessionHandleStore.materialize({
    id,
    parentId: null,
    role: "resident",
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: SessionHandleStore.currentPolicyGeneration(),
    actionId: crypto.randomUUID(),
    at: clock(),
  });
  let tail: Promise<void> = Promise.resolve();
  return (_sender, request, body) => {
    const operation = tail.then(async () => {
      const row = SessionHandleStore.row(id);
      const owner = crypto.randomUUID();
      const lease = SessionHandleStore.acquireLease({
        sessionId: id,
        owner,
        expectedFence: row.leaseFence,
        now: clock(),
        expiresAt: clock() + SessionHandleStore.LEASE_TTL_MS,
      });
      if (!lease.ok) throw new Error(`gateway ingress lease ${lease.reason}`);
      const executor = createExecutor({
        identity: { sessionId: id, role: "resident", parentActionId: null },
        policy: compilePolicySnapshot({
          rows: SessionHandleStore.policyRows(row.policyGeneration),
          generation: row.policyGeneration,
          kinds: LedgerAction.Kind.options,
        }),
        ledger: {
          async commit(action) {
            const current = SessionHandleStore.row(id);
            const committed = SessionHandleStore.commit({
              sessionId: id,
              owner,
              fence: lease.fence,
              now: clock(),
              expectedRevision: current.revision,
              actions: [action],
              consumeInboxIds: [],
              state: "idle",
              releaseLease: false,
            });
            if (!committed.ok) throw new Error(`gateway message commit ${committed.reason}`);
            const receipt = committed.receipts[0];
            if (receipt === undefined) throw new Error("gateway message action receipt missing");
            return receipt;
          },
        },
        observations: Bus,
        clock,
        entropy: () => crypto.randomUUID(),
      });
      try {
        const result = await executor.run(request, body);
        return { ...result, matchedRuleIds: messageDecisionRules(id, request) };
      } finally {
        const current = SessionHandleStore.row(id);
        SessionHandleStore.commit({
          sessionId: id,
          owner,
          fence: lease.fence,
          now: clock(),
          expectedRevision: current.revision,
          actions: [],
          consumeInboxIds: [],
          state: "idle",
          releaseLease: true,
        });
      }
    });
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
}
