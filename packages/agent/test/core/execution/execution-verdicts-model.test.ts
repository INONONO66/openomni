import { describe, expect, it, mock } from "bun:test";
import { createExecutor, type ExecutionLedger } from "../../../src/index";
import { compilePolicySnapshot } from "@openomni/policy";
import type { LedgerAction, PlainValue, PolicyRow } from "@openomni/protocol";

const kinds = ["prompt", "turn", "llm", "tool"] as const;

function row(
  name: string,
  kind: (typeof kinds)[number],
  phase: PolicyRow.Phase,
  verdict: PlainValue,
  priority = 0,
): PolicyRow.Row {
  return {
    name,
    kind,
    phase,
    match: { encodingVersion: 1, value: { op: "test" } },
    verdict: { encodingVersion: 1, value: verdict },
    priority,
    generation: 1,
  };
}

const mandatory: PolicyRow.Row = {
  ...row("compaction", "turn", "post", { type: "allow" }),
  match: { encodingVersion: 1, value: { op: "compaction" } },
};

function harness(rows: readonly PolicyRow.Row[]) {
  const actions: LedgerAction.Append[] = [];
  let revision = 0;
  const ledger: ExecutionLedger = {
    async commit(action) {
      actions.push(action);
      revision += 1;
      return { action: { ...action, ordinal: revision }, revision };
    },
  };
  const executor = createExecutor({
    policy: compilePolicySnapshot({ generation: 1, rows: [mandatory, ...rows], mandatory: ["compaction"] }),
    ledger,
    observations: { publish: () => undefined },
    identity: { sessionId: "session-1", role: "resident", parentActionId: null },
    clock: () => 100,
    entropy: (() => {
      let value = 0;
      return () => `action-${++value}`;
    })(),
  });
  return { actions, executor };
}

function resultEffects(actions: readonly LedgerAction.Append[], kind: LedgerAction.Kind) {
  return actions
    .filter((action) => action.kind === kind)
    .map((action) => action.effect.value)
    .filter((effect) =>
      typeof effect === "object" && effect !== null && !Array.isArray(effect)
        ? effect.phase === "result"
        : false,
    );
}

describe("the single L2 executor's four-kind verdict model", () => {
  for (const kind of kinds) {
    it(`${kind}: pre deny commits no intent/result and never calls body`, async () => {
      const { actions, executor } = harness([
        row(`deny-${kind}-pre`, kind, "pre", { type: "deny", reason: "pre blocked" }),
      ]);
      const body = mock(async () => ({ ok: true }));

      const result = await executor.run(
        { kind, op: "test", intent: { requested: true }, effect: { completed: true } },
        body,
      );

      expect(result).toMatchObject({ terminal: "blocked_pre", reason: "pre blocked" });
      expect(body).toHaveBeenCalledTimes(0);
      expect(actions.filter((action) => action.kind === kind)).toHaveLength(0);
      expect(resultEffects(actions, kind)).toHaveLength(0);
    });

    it(`${kind}: allow commits intent/result and calls body exactly once`, async () => {
      const { actions, executor } = harness([]);
      const body = mock(async () => ({ ok: true }));

      const result = await executor.run(
        { kind, op: "test", intent: { requested: true }, effect: { completed: true } },
        body,
      );

      expect(result).toMatchObject({ terminal: "executed", value: { ok: true } });
      expect(body).toHaveBeenCalledTimes(1);
      expect(actions.filter((action) => action.kind === kind)).toHaveLength(2);
      expect(resultEffects(actions, kind)).toEqual([
        expect.objectContaining({ phase: "result", terminal: "executed" }),
      ]);
    });

    it(`${kind}: post deny reverts when a reverter exists`, async () => {
      const { actions, executor } = harness([
        row(`deny-${kind}-post`, kind, "post", { type: "deny", reason: "post blocked" }),
      ]);
      const revert = mock(async () => undefined);

      const result = await executor.run(
        {
          kind,
          op: "test",
          intent: { requested: true },
          effect: { completed: true },
          revert,
        },
        async () => ({ ok: true }),
      );

      expect(result).toMatchObject({
        terminal: "blocked_post",
        disposition: "reverted",
        reason: "post blocked",
      });
      expect(revert).toHaveBeenCalledTimes(1);
      expect(resultEffects(actions, kind)).toEqual([
        expect.objectContaining({
          phase: "result",
          terminal: "blocked_post",
          disposition: "reverted",
        }),
      ]);
    });

    it(`${kind}: post deny records irreversible when no reverter exists`, async () => {
      const { actions, executor } = harness([
        row(`deny-${kind}-post`, kind, "post", { type: "deny", reason: "post blocked" }),
      ]);

      const result = await executor.run(
        { kind, op: "test", intent: { requested: true }, effect: { completed: true } },
        async () => ({ ok: true }),
      );

      expect(result).toMatchObject({
        terminal: "blocked_post",
        disposition: "irreversible",
        reason: "post blocked",
      });
      expect(resultEffects(actions, kind)).toEqual([
        expect.objectContaining({
          phase: "result",
          terminal: "blocked_post",
          disposition: "irreversible",
        }),
      ]);
    });
  }
});
