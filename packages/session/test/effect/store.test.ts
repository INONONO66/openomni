import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EffectStore, EffectStoreError, Storage, WorkItemStore } from "../../src/index";
import { bareStorageAdapter } from "../helpers/wait";

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

function intent(overrides: Partial<Parameters<typeof EffectStore.intend>[0]> = {}) {
  return {
    effectId: "effect-1",
    kind: "http.post",
    target: "https://example.test/webhook",
    ...overrides,
  };
}

async function createWorkItem(hash = "linked"): Promise<string> {
  const item = await WorkItemStore.create(
    {
      name: "effect-linked work",
      sourceMessageId: `msg-${hash}`,
      sourceChannel: "test",
      intent: "verification",
      goal: "link an effect",
      sessionId: `session-${hash}`,
      acceptanceCriteria: ["effect confirmed"],
    },
    "trace-test",
  );
  return item.hash;
}

describe("EffectStore durable sequence", () => {
  test("intend records a pending intent at seq 1 (record-before-act)", () => {
    const result = EffectStore.intend(intent());

    expect(result.fresh).toBe(true);
    expect(result.status.status).toBe("pending");
    // materializationCount stays 0 until a terminal outcome fact is recorded.
    expect(result.status.materializationCount).toBe(0);
    expect(EffectStore.status("effect-1").status).toBe("pending");
  });

  test("confirm records the one terminal outcome and materializes", () => {
    EffectStore.intend(intent());

    const confirmed = EffectStore.confirm("effect-1", "receipt-123");

    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.materializationCount).toBe(1);
    expect(confirmed.receipt).toBe("receipt-123");
  });

  test("fail records a definite failure distinct from unknown", () => {
    EffectStore.intend(intent());

    const failed = EffectStore.fail("effect-1", "upstream 500");

    expect(failed.status).toBe("failed");
    expect(failed.materializationCount).toBe(1);
    expect(failed.reason).toBe("upstream 500");
  });

  test("re-intending an existing effect id is an idempotent replay (fresh=false)", () => {
    EffectStore.intend(intent());

    const replay = EffectStore.intend(intent());

    expect(replay.fresh).toBe(false);
    expect(replay.status.status).toBe("pending");

    EffectStore.confirm("effect-1");
    const afterTerminal = EffectStore.intend(intent());
    expect(afterTerminal.fresh).toBe(false);
    expect(afterTerminal.status.status).toBe("confirmed");
  });

  test("confirm is idempotent on same-outcome replay", () => {
    EffectStore.intend(intent());
    EffectStore.confirm("effect-1", "r1");

    const again = EffectStore.confirm("effect-1", "r1");
    expect(again.status).toBe("confirmed");
  });

  test("recording a second, different terminal outcome fails closed", () => {
    EffectStore.intend(intent());
    EffectStore.confirm("effect-1");

    let code: string | undefined;
    try {
      EffectStore.fail("effect-1", "too late");
    } catch (error) {
      if (error instanceof EffectStoreError) code = error.code;
    }
    expect(code).toBe("already_terminal");
  });

  test("finalizing without an intent fails closed", () => {
    let code: string | undefined;
    try {
      EffectStore.confirm("never-intended");
    } catch (error) {
      if (error instanceof EffectStoreError) code = error.code;
    }
    expect(code).toBe("not_intended");
  });

  test("outstandingIntents surfaces only outcome-less intents (crash-window scan)", () => {
    EffectStore.intend(intent({ effectId: "effect-a" }));
    EffectStore.intend(intent({ effectId: "effect-b" }));
    EffectStore.intend(intent({ effectId: "effect-c" }));
    EffectStore.confirm("effect-b");

    const outstanding = EffectStore.outstandingIntents();
    const ids = outstanding.map((entry) => entry.effectId).sort();

    expect(ids).toEqual(["effect-a", "effect-c"]);
  });

  test("terminalIntents surfaces only terminal intents paired with their outcome", () => {
    EffectStore.intend(intent({ effectId: "t-a" }));
    EffectStore.intend(intent({ effectId: "t-b" }));
    EffectStore.intend(intent({ effectId: "t-c" }));
    EffectStore.confirm("t-a", "receipt");
    EffectStore.fail("t-b", "boom");
    // t-c stays outcome-less → excluded (it is outstanding, not terminal).

    const terminal = EffectStore.terminalIntents()
      .map((entry) => [entry.intent.effectId, entry.outcome])
      .sort();

    expect(terminal).toEqual([
      ["t-a", "confirmed"],
      ["t-b", "failed"],
    ]);
  });

  test("durable effect writes fail closed without a ledger adapter", () => {
    Storage.reset();
    Storage.configure(bareStorageAdapter());

    let code: string | undefined;
    try {
      EffectStore.intend(intent());
    } catch (error) {
      if (error instanceof EffectStoreError) code = error.code;
    }
    expect(code).toBe("adapter_absent");
  });
});

describe("WorkItemStore.recordEffect projection (#490 linkage)", () => {
  test("appends an EffectRecord carrying the current attempt and no outcome for pending", async () => {
    const hash = await createWorkItem("pending");

    const updated = WorkItemStore.recordEffect(hash, { intentRef: "effect-1" });

    const record = updated?.completionFacts.effects.at(-1);
    expect(record?.intentRef).toBe("effect-1");
    expect(record?.attempt).toBe(1);
    expect(record?.outcome).toBeUndefined();
  });

  test("records a terminal transition as a NEW append (append-only log)", async () => {
    const hash = await createWorkItem("terminal");

    WorkItemStore.recordEffect(hash, { intentRef: "effect-1" });
    const confirmed = WorkItemStore.recordEffect(hash, {
      intentRef: "effect-1",
      outcome: "confirmed",
    });

    const forIntent = confirmed?.completionFacts.effects.filter(
      (entry) => entry.intentRef === "effect-1",
    );
    expect(forIntent).toHaveLength(2);
    expect(forIntent?.map((entry) => entry.outcome)).toEqual([undefined, "confirmed"]);
  });

  test("is idempotent when the latest state for an intent already matches", async () => {
    const hash = await createWorkItem("idem");

    WorkItemStore.recordEffect(hash, { intentRef: "effect-1", outcome: "confirmed" });
    const again = WorkItemStore.recordEffect(hash, { intentRef: "effect-1", outcome: "confirmed" });

    expect(again?.completionFacts.effects.filter((e) => e.intentRef === "effect-1")).toHaveLength(
      1,
    );
  });
});
