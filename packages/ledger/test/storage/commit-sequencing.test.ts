import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Wait } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { Storage, WaitStore } from "../../src/index";
import { buildWaitCreate, commitCancel, commitReply } from "../helpers/wait";

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
 *      (Wait `revision_conflict`) — the taxonomy is per-domain, the mechanics are not.
 */

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:", observationSink: Bus });
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
  test("head equals the projected revision after the opening fact", () => {
    const wait = WaitStore.create(buildWaitCreate(), "trace-w");
    const waitHead = ledger().headFact(`wait:${wait.id}`);
    expect(waitHead?.type).toBe("wait.opened");
    expect(waitHead?.seq).toBe(wait.revision);
  });

  test("each transition appends at the pre-transition revision and advances head with it", () => {
    const wait = WaitStore.create(buildWaitCreate(), "trace-w");
    expect(wait.revision).toBe(1);

    const outcome = commitReply(
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
      commitCancel(wait.id, "trace-cancel");
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
    } finally {
      Object.defineProperty(adapter, "transaction", { configurable: true, value: original });
    }
  });

  test("Bus publishes land only after the transaction committed", async () => {
    const seen: string[] = [];
    Bus.observe((event) => {
      if (event.name.startsWith("wait.")) {
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
    commitCancel(wait.id, "trace-cancel");
    const headAfterCancel = ledger().headFact(`wait:${wait.id}`);
    expect(headAfterCancel?.type).toBe("wait.cancelled");

    // Cancelling a cancelled wait is a rejected fold: no fact, no revision bump.
    const rejected = commitCancel(wait.id, "trace-cancel-2");
    expect(rejected.kind).toBe("rejected");
    expect(ledger().headFact(`wait:${wait.id}`)?.seq).toBe(headAfterCancel?.seq);
    expect(WaitStore.get(wait.id)?.revision).toBe(headAfterCancel?.seq);
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
