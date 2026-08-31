import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Engagement, Wait, WorkItem } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { EngagementStore, Storage, WaitStore, WorkItemStore } from "../../src/index";
import { buildWaitCreate } from "../helpers/wait";

/**
 * Characterization of the ONE durable write-ordering contract every
 * decision-class ledger store obeys (#510). This pins the observable
 * sequence — not any store's internal spelling — so the shared commit
 * coordinator can absorb the mechanics without moving a domain fold:
 *
 *   1. the decision fact appends to the owner stream at expectedHead =
 *      the pre-transition revision;
 *   2. the projection lands under a revision compare-and-set;
 *   3. both commit inside ONE storage transaction (a projection failure
 *      rolls the appended fact back, so head === revision always);
 *   4. Bus publishes fire only AFTER the transaction committed;
 *   5. a stale head surfaces as the store's OWN typed conflict error
 *      (Wait/Engagement `revision_conflict`, WorkItem
 *      WorkItemRevisionError) — the taxonomy is per-domain, the
 *      mechanics are not.
 *
 * WorkItem, Wait, and Engagement are asserted through the same table so a
 * divergence in any one of them fails here rather than in one store's
 * private suite.
 */

const T0 = 1_700_000_000_000;

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

const flushBus = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

function ledger() {
  const sub = Storage.get().ledger;
  if (!sub) throw new Error("ledger sub-adapter absent in the in-memory sqlite storage");
  return sub;
}

describe("decision-class commit sequencing (shared contract)", () => {
  test("head equals the projected revision after the opening fact in every store", () => {
    const wait = WaitStore.create(buildWaitCreate(), "trace-w");
    const engagement = EngagementStore.open(
      { id: "eng-1", ownerSessionId: "ses-1", title: "t", terms: { spendCeiling: 1 } },
      "trace-e",
      T0,
    );

    const waitHead = ledger().headFact(`wait:${wait.id}`);
    expect(waitHead?.type).toBe("wait.opened");
    expect(waitHead?.seq).toBe(wait.revision);

    const engagementHead = ledger().headFact(`engagement:${engagement.id}`);
    expect(engagementHead?.type).toBe("engagement.opened");
    expect(engagementHead?.seq).toBe(engagement.revision);
  });

  test("each transition appends at the pre-transition revision and advances head with it", () => {
    const wait = WaitStore.create(buildWaitCreate(), "trace-w");
    expect(wait.revision).toBe(1);

    const outcome = WaitStore.attachReply(
      wait.id,
      { replyKey: "rk-1", responderCandidates: ["actor-a"], messageId: "in-1", at: 1_000 },
      "trace-attach",
    );
    if (outcome.kind !== "attached") throw new Error(`expected attached, got ${outcome.kind}`);
    // Fact seq N is the append that produced projected revision N.
    expect(outcome.record.revision).toBe(2);
    expect(ledger().headFact(`wait:${wait.id}`)?.seq).toBe(2);
    expect(ledger().headFact(`wait:${wait.id}`)?.type).toBe("wait.attached");
    expect(WaitStore.get(wait.id)?.revision).toBe(2);

    const engagement = EngagementStore.open(
      { id: "eng-1", ownerSessionId: "ses-1", title: "t", terms: { spendCeiling: 1 } },
      "trace-e",
      T0,
    );
    const moved = EngagementStore.transition(
      engagement.id,
      { to: "deliberating", at: T0 + 1, reason: "test" },
      "trace-move",
    );
    if (moved.kind !== "transitioned") throw new Error(`expected transitioned, got ${moved.kind}`);
    expect(moved.record.revision).toBe(2);
    expect(ledger().headFact(`engagement:${engagement.id}`)?.seq).toBe(2);
    expect(EngagementStore.get(engagement.id)?.revision).toBe(2);
  });

  test("a stale expected head writes nothing and surfaces the domain's typed conflict", () => {
    const wait = WaitStore.create(buildWaitCreate(), "trace-w");
    // Advance the owner stream out from under the next transition's
    // expectedHead without touching the projection row.
    const appended = ledger().append(
      { streamId: `wait:${wait.id}`, type: "wait.probe", data: { revision: 2 } },
      wait.revision,
    );
    expect(appended.kind).toBe("appended");
    const headBefore = ledger().headFact(`wait:${wait.id}`);

    let thrown: unknown;
    try {
      WaitStore.cancel(wait.id, "trace-cancel");
    } catch (error) {
      thrown = error;
    }
    expect(Wait.StoreError.isInstance(thrown)).toBe(true);
    if (!Wait.StoreError.isInstance(thrown)) throw new Error("unreachable");
    expect(thrown.data.code).toBe("revision_conflict");

    // Nothing was written: head and projection are exactly as before.
    expect(ledger().headFact(`wait:${wait.id}`)?.seq).toBe(headBefore?.seq);
    expect(ledger().headFact(`wait:${wait.id}`)?.type).toBe("wait.probe");
    expect(WaitStore.get(wait.id)?.status).toBe("open");
    expect(WaitStore.get(wait.id)?.revision).toBe(1);
  });

  test("engagement reports its own conflict taxonomy for the same stale-head mechanic", () => {
    const engagement = EngagementStore.open(
      { id: "eng-1", ownerSessionId: "ses-1", title: "t", terms: { spendCeiling: 1 } },
      "trace-e",
      T0,
    );
    const appended = ledger().append(
      { streamId: `engagement:${engagement.id}`, type: "engagement.probe", data: { revision: 2 } },
      engagement.revision,
    );
    expect(appended.kind).toBe("appended");

    let thrown: unknown;
    try {
      EngagementStore.transition(
        engagement.id,
        { to: "deliberating", at: T0 + 1, reason: "test" },
        "trace-move",
      );
    } catch (error) {
      thrown = error;
    }
    expect(Engagement.StoreError.isInstance(thrown)).toBe(true);
    if (!Engagement.StoreError.isInstance(thrown)) throw new Error("unreachable");
    expect(thrown.data.code).toBe("revision_conflict");
    expect(thrown.data.engagementId).toBe(engagement.id);
    expect(EngagementStore.get(engagement.id)?.state).toBe("planning");
    expect(EngagementStore.get(engagement.id)?.revision).toBe(1);
  });

  test("SQLITE_BUSY at the transaction entry maps to each store's typed unavailable", () => {
    // The store transaction entry is the single mapping point: a busy
    // database means nothing committed, so callers branch on the typed
    // taxonomy rather than on driver message text.
    const adapter = Storage.get();
    const original = adapter.transaction.bind(adapter);
    Object.defineProperty(adapter, "transaction", {
      configurable: true,
      value: () => {
        const busy = new Error("database is locked") as Error & { code: string; errno: number };
        busy.code = "SQLITE_BUSY";
        busy.errno = 5;
        throw busy;
      },
    });
    try {
      const waitError = captureThrown(() => WaitStore.create(buildWaitCreate(), "trace-w"));
      expect(Wait.StoreError.isInstance(waitError)).toBe(true);
      if (!Wait.StoreError.isInstance(waitError)) throw new Error("unreachable");
      expect(waitError.data.code).toBe("unavailable");
      expect(waitError.data.message).toContain("database is locked");

      const engagementError = captureThrown(() =>
        EngagementStore.open(
          { id: "eng-1", ownerSessionId: "ses-1", title: "t", terms: { spendCeiling: 1 } },
          "trace-e",
          T0,
        ),
      );
      expect(Engagement.StoreError.isInstance(engagementError)).toBe(true);
      if (!Engagement.StoreError.isInstance(engagementError)) throw new Error("unreachable");
      expect(engagementError.data.code).toBe("unavailable");
      expect(engagementError.data.message).toContain("database is locked");
    } finally {
      Object.defineProperty(adapter, "transaction", { configurable: true, value: original });
    }
  });

  test("Bus publishes land only after the transaction committed", async () => {
    const seen: string[] = [];
    Bus.observe((event) => {
      if (event.name.startsWith("wait.") || event.name.startsWith("engagement.")) {
        // At observation time the durable write is already visible.
        seen.push(event.name);
      }
    });

    const wait = WaitStore.create(buildWaitCreate(), "trace-w");
    // The record is readable the instant create returns, i.e. before any
    // subscriber ran — publishes are a post-commit projection, never the
    // commit itself.
    expect(WaitStore.get(wait.id)?.revision).toBe(1);
    expect(seen).toEqual([]);

    await flushBus();
    expect(seen).toEqual(["wait.opened"]);
  });

  test("a rejected fold writes no fact and leaves head at the projected revision", () => {
    const wait = WaitStore.create(buildWaitCreate(), "trace-w");
    WaitStore.cancel(wait.id, "trace-cancel");
    const headAfterCancel = ledger().headFact(`wait:${wait.id}`);
    expect(headAfterCancel?.type).toBe("wait.cancelled");

    // Cancelling a cancelled wait is a rejected fold: no fact, no revision bump.
    const rejected = WaitStore.cancel(wait.id, "trace-cancel-2");
    expect(rejected.kind).toBe("rejected");
    expect(ledger().headFact(`wait:${wait.id}`)?.seq).toBe(headAfterCancel?.seq);
    expect(WaitStore.get(wait.id)?.revision).toBe(headAfterCancel?.seq);
  });

  test("work item transitions share the same head-follows-revision binding", async () => {
    const created = await WorkItemStore.create(
      {
        name: "commit-sequencing",
        sourceMessageId: "msg-commit-seq",
        sourceChannel: "test",
        intent: "verify",
        goal: "pin the shared commit sequence",
        sessionId: "ses-1",
        acceptanceCriteria: ["head follows revision"],
      },
      "trace-wi",
    );
    expect(ledger().headFact(`work:${created.workItemId}`)?.type).toBe("work_item.created");
    expect(ledger().headFact(`work:${created.workItemId}`)?.seq).toBe(created.revision);

    const started = await WorkItemStore.start(created.workItemId, "trace-start");
    expect(started?.revision).toBe(created.revision + 1);
    expect(ledger().headFact(`work:${created.workItemId}`)?.seq).toBe(started?.revision);
    if (!started) throw new Error("start returned undefined for an existing work item");
    expect(WorkItem.deriveStatus(started)).toBe("running");
  });
});

function captureThrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw, but nothing was thrown");
}
