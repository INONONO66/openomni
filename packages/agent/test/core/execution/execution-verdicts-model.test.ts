import { describe, expect, it, mock } from "bun:test";
import {
  createExecutor,
  type ExecutionLedger,
  UnregisteredExecutionKindError,
} from "../../../src/index";
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
  it("refuses an unregistered kind with a typed error before policy or body", async () => {
    const { actions, executor } = harness([]);
    const body = mock(async () => ({ ok: true }));

    expect(
      executor.run(
        { kind: "channel.send", op: "test", intent: {}, effect: {} },
        body,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "UnregisteredExecutionKindError",
        code: "unregistered_execution_kind",
        kind: "channel.send",
      }),
    );
    expect(body).toHaveBeenCalledTimes(0);
    expect(actions).toHaveLength(0);
    expect(new UnregisteredExecutionKindError("x")).toBeInstanceOf(Error);
  });

  it("registers extension kinds as declarative data", async () => {
    const actions: LedgerAction.Append[] = [];
    let revision = 0;
    const executor = createExecutor({
      policy: compilePolicySnapshot({ generation: 1, rows: [mandatory], mandatory: ["compaction"] }),
      ledger: {
        async commit(action) {
          actions.push(action);
          revision += 1;
          return { action: { ...action, ordinal: revision }, revision };
        },
      },
      observations: { publish: () => undefined },
      identity: { sessionId: "session-1", role: "resident", parentActionId: null },
      clock: () => 100,
      entropy: () => `extension-${revision + 1}`,
      extensionKinds: [
        {
          kind: "channel.send",
          effect: { grade: "external" },
          reversible: false,
          inputSchema: { type: "object" },
        },
      ],
    });

    const result = await executor.run(
      { kind: "channel.send", op: "test", intent: {}, effect: {} },
      async () => ({ delivered: true }),
    );

    expect(result).toMatchObject({ terminal: "executed" });
    expect(actions).toHaveLength(4);
  });

  it("passes the committed intent receipt to the body after its commit resolves", async () => {
    const intentCommitReached = Promise.withResolvers<void>();
    const releaseIntentCommit = Promise.withResolvers<void>();
    let revision = 0;
    let committedIntent: LedgerAction.Receipt | undefined;
    let bodyIntent: LedgerAction.Receipt | undefined;
    const body = mock(async (intent: LedgerAction.Receipt) => {
      bodyIntent = intent;
      return { ok: true };
    });
    const executor = createExecutor({
      policy: compilePolicySnapshot({
        generation: 1,
        rows: [mandatory],
        mandatory: ["compaction"],
      }),
      ledger: {
        async commit(action) {
          const isIntent = action.kind === "llm" && committedIntent === undefined;
          if (isIntent) {
            intentCommitReached.resolve();
            await releaseIntentCommit.promise;
          }
          revision += 1;
          const receipt = {
            action: { ...action, ordinal: revision },
            revision,
          } satisfies LedgerAction.Receipt;
          if (isIntent) committedIntent = receipt;
          return receipt;
        },
      },
      observations: { publish: () => undefined },
      identity: {
        sessionId: "session-1",
        role: "resident",
        parentActionId: "turn-intent-1",
      },
      clock: () => 100,
      entropy: () => `receipt-${revision + 1}`,
    });

    const running = executor.run(
      { kind: "llm", op: "test", intent: {}, effect: {} },
      body,
    );
    await intentCommitReached.promise;
    expect(body).toHaveBeenCalledTimes(0);

    releaseIntentCommit.resolve();
    await running;

    expect(body).toHaveBeenCalledTimes(1);
    expect(bodyIntent).toBe(committedIntent);
    expect(bodyIntent?.action.parentId).toBe("turn-intent-1");
  });

  it("fails closed when a transform removes the result envelope", async () => {
    const { actions, executor } = harness([
      row("remove-result", "tool", "post", {
        type: "transform",
        name: "redact",
        paths: ["result"],
      }),
    ]);

    const result = await executor.run(
      { kind: "tool", op: "test", intent: {}, effect: {} },
      async () => ({ ok: true }),
    );

    expect(result).toMatchObject({ terminal: "blocked_post", reason: "invalid_output" });
    expect(resultEffects(actions, "tool")).toEqual([
      expect.objectContaining({ terminal: "blocked_post", reason: "invalid_output" }),
    ]);
  });

  it("commits a linked failed result before rethrowing a body failure", async () => {
    const { actions, executor } = harness([]);
    const failure = new TypeError("body failed");

    await expect(
      executor.run(
        { kind: "tool", op: "test", intent: { requested: true }, effect: { completed: false } },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    expect(actions.map((action) => action.kind)).toEqual([
      "policy.decision",
      "tool",
      "tool",
    ]);
    const intent = actions[1];
    const result = actions[2];
    expect(result?.parentId).toBe(intent?.id);
    expect(result?.effect.value).toEqual({
      phase: "result",
      terminal: "failed",
      effect: { completed: false },
      error: { name: "TypeError" },
    });
  });

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
