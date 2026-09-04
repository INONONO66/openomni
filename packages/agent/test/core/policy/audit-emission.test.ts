import { expect, it } from "bun:test";
import { createExecutor, type ExecutionLedger } from "../../../src/index";
import { compilePolicySnapshot } from "@openomni/policy";
import { L0Observation, type LedgerAction, type PolicyRow } from "@openomni/protocol";

function policyRow(
  name: string,
  kind: PolicyRow.Row["kind"],
  phase: PolicyRow.Phase,
  verdict: PolicyRow.Row["verdict"]["value"],
): PolicyRow.Row {
  return {
    name,
    kind,
    phase,
    match: { encodingVersion: 1, value: { op: "read" } },
    verdict: { encodingVersion: 1, value: verdict },
    priority: 100,
    generation: 7,
  };
}

it("awaits policy.decision commit before publishing its observation", async () => {
  const appended: LedgerAction.Append[] = [];
  const observations: string[] = [];
  const decisionCommit = Promise.withResolvers<void>();
  let revision = 0;
  const ledger: ExecutionLedger = {
    async append(action) {
      if (action.kind === "policy.decision") await decisionCommit.promise;
      appended.push(action);
      revision += 1;
      return { action: { ...action, ordinal: revision }, revision };
    },
  };
  const executor = createExecutor({
    policy: compilePolicySnapshot({
      generation: 7,
      mandatory: ["compaction"],
      rows: [
        { ...policyRow("compaction", "turn", "post", { type: "allow" }), match: { encodingVersion: 1, value: {} } },
        policyRow("allow-read", "tool", "pre", { type: "allow" }),
      ],
    }),
    ledger,
    observations: {
      publish(event, value) {
        if (event.name === L0Observation.ActionCommittedEvent.name) {
          observations.push(value.id);
        }
      },
    },
    identity: {
      sessionId: "session-audit",
      role: "resident",
      parentActionId: "turn-parent",
    },
    clock: () => 42,
    entropy: (() => {
      let index = 0;
      return () => `audit-${++index}`;
    })(),
  });

  const running = executor.run(
    { kind: "tool", op: "read", intent: { path: "/tmp/a" }, effect: { ok: true } },
    async () => "done",
  );
  await Promise.resolve();
  expect(appended).toHaveLength(0);
  expect(observations).toHaveLength(0);

  decisionCommit.resolve();
  await running;

  const decision = appended.find((action) => action.kind === "policy.decision");
  expect(decision).toMatchObject({
    parentId: "turn-parent",
    sessionId: "session-audit",
    kind: "policy.decision",
    intent: {
      value: {
        hook: "tool.pre",
        generation: 7,
        matchedRuleIds: ["allow-read"],
        verdict: "allow",
      },
    },
  });
  const value = decision?.intent.value;
  expect(typeof value === "object" && value !== null && !Array.isArray(value) ? value.inputHash : undefined)
    .toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(observations[0]).toBe(decision?.id);
  expect(appended.findIndex((action) => action.id === observations[0])).toBe(0);
});
