import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import {
  PlainValueSchema,
  type LedgerAction,
  type PlainObject,
  type PolicyRow,
} from "@openomni/protocol";
import { createCompactionPlan } from "../src/compaction/durable";
import { ContextRestoreError } from "../src/compaction/restore";
import { createAssistantMessage } from "../src/core/message-factory";
import {
  Bus,
  closeSessions,
  createTurnDispatcher,
  SEEDED_POLICY_ROWS,
  session,
  type SessionRunner,
  type SessionRuntime,
} from "../src/index";
import { foldSessionHistory } from "../src/session-lifecycle/history";

let nextId = 0;
const runtime: SessionRuntime = {
  observations: Bus,
  clock: () => 1_000,
  entropy: () => `restore-id-${++nextId}`,
  processId: "restore-test",
  scheduleHeartbeat: () => () => undefined,
};

function seed(rows: readonly Omit<PolicyRow.Row, "generation">[] = []): void {
  const policies = Storage.get().policies;
  if (policies === undefined) throw new Error("missing policy adapter");
  for (const row of [...SEEDED_POLICY_ROWS, ...rows]) policies.append({ ...row, generation: 1 });
}

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  nextId = 0;
  Storage.initialize({ dbPath: ":memory:", observationSink: Bus });
});

afterEach(async () => {
  await closeSessions(runtime);
  Storage.reset();
  Bus.reset();
});

/** A turn that answers, then compacts the prompt away behind its own answer, exactly as the real cut records it. */
const compactingRunner: SessionRunner = async (input) => {
  const { executor } = createTurnDispatcher([], input, runtime);
  const answer = createAssistantMessage("answer", "", input.sessionId);
  await executor.run(
    { kind: "message", op: "assistant", intent: { messageId: answer.info.id }, effect: {} },
    async () => PlainValueSchema.parse(answer),
  );
  const prior = foldSessionHistory(input.sessionId, input.ledger.actions?.() ?? []);
  const plan = createCompactionPlan(prior, [answer], 100);
  await executor.run(
    {
      kind: "compaction",
      op: "compact",
      intent: { trigger: "threshold" },
      effect: {},
      revertData: () => PlainValueSchema.parse(plan.record.revert),
    },
    async () => PlainValueSchema.parse({ ...plan.record, projection: plan.projection }),
  );
  return { kind: "result", text: "answer", finishReason: "stop" };
};

function intentRecord(action: LedgerAction.Node): PlainObject {
  const value = action.intent.value;
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function compactionIntent(actions: readonly LedgerAction.Node[]): LedgerAction.Node {
  const found = actions.find(
    (action) =>
      action.kind === "compaction" &&
      intentRecord(action).phase === "intent" &&
      intentRecord(action).op === "compact",
  );
  if (found === undefined) throw new Error("missing compaction intent");
  return found;
}

function nth(actions: readonly LedgerAction.Node[], index: number): LedgerAction.Node {
  const action = actions[index];
  if (action === undefined) throw new Error(`missing action ${index}`);
  return action;
}

/** One prompted session whose first turn compacted; `before` is its action tree at rest. */
async function compactedSession() {
  const handle = session({ id: "ctx", role: "resident", runner: compactingRunner }, runtime);
  await handle.prompt("hello");
  return { handle, before: SessionHandleStore.tree("ctx") };
}

describe("restore_context_projection", () => {
  test("appends the typed compensation, restores the prior projection and leaves the compaction intact", async () => {
    seed();
    const { handle, before } = await compactedSession();
    const compaction = compactionIntent(before);
    expect(foldSessionHistory("ctx", before).map((entry) => entry.info.role)).toEqual(["assistant"]);

    const outcome = await handle.restoreContext(compaction.id);

    expect(outcome.terminal).toBe("executed");
    const after = SessionHandleStore.tree("ctx");
    expect(after.slice(0, before.length)).toEqual(before);
    const appended = after.slice(before.length);
    expect(appended.map((action) => [action.kind, action.parentId])).toEqual([
      ["policy.decision", compaction.id],
      ["compaction", compaction.id],
      ["policy.decision", compaction.id],
      ["compaction", nth(appended, 1).id],
    ]);
    expect(nth(appended, 0).intent.value).toMatchObject({
      hook: "turn.post",
      op: "restore_context_projection",
    });
    expect(nth(appended, 1).intent.value).toMatchObject({
      op: "restore_context_projection",
      value: { compactionId: compaction.id },
      recovery: "local_transactional",
    });
    expect(nth(appended, 3).effect.value).toMatchObject({
      terminal: "executed",
      result: { restored: { compactionId: compaction.id, discarded: { count: 1 } } },
    });
    const restored = foldSessionHistory("ctx", after);
    expect(restored.map((entry) => entry.info.role)).toEqual(["user", "assistant"]);
    expect(restored).toEqual(foldSessionHistory("ctx", before.slice(0, before.indexOf(compaction))));
    expect(SessionHandleStore.row("ctx").leaseOwner).toBeNull();
  });

  test("a refused restoration records only the policy decision and changes nothing", async () => {
    seed([
      {
        name: "no-restore",
        kind: "turn",
        phase: "post",
        match: { encodingVersion: 1, value: { op: "restore_context_projection" } },
        verdict: { encodingVersion: 1, value: { type: "deny", reason: "pinned_projection" } },
        priority: 500,
      },
    ]);
    const { handle, before } = await compactedSession();

    const outcome = await handle.restoreContext(compactionIntent(before).id);

    expect(outcome).toEqual({ terminal: "blocked_pre", reason: "pinned_projection" });
    const after = SessionHandleStore.tree("ctx");
    expect(after.slice(before.length).map((action) => action.kind)).toEqual(["policy.decision"]);
    expect(foldSessionHistory("ctx", after)).toEqual(foldSessionHistory("ctx", before));
  });

  test("an unknown or unexecuted compaction is refused before anything is recorded", async () => {
    seed();
    const { handle, before } = await compactedSession();
    const compaction = compactionIntent(before);

    await expect(handle.restoreContext("nope")).rejects.toBeInstanceOf(ContextRestoreError);
    const result = before.find(
      (action) => action.kind === "compaction" && action.parentId === compaction.id,
    );
    await expect(handle.restoreContext(result?.id ?? "")).rejects.toMatchObject({
      reason: "not_executed",
    });
    expect(SessionHandleStore.tree("ctx")).toEqual(before);
    expect(SessionHandleStore.row("ctx").leaseOwner).toBeNull();
  });
});
