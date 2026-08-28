import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgressBudgetStore, Storage } from "../../src/index";

/** #219 active-egress debit ledger: atomic, idempotent counted-window claims. */
describe("EgressBudgetStore", () => {
  const NOW = 5_000_000_000_000;
  const WINDOW = 60_000;

  const row = (
    id: string,
    overrides: Partial<Parameters<typeof EgressBudgetStore.claim>[0]> = {},
  ) => ({
    id,
    senderId: "s",
    targetActorId: "t",
    class: "notify" as const,
    at: NOW,
    ...overrides,
  });

  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
  });

  test("an empty ledger presents a zero state to the first claim", () => {
    let observed: unknown;
    const result = EgressBudgetStore.claim(row("first"), NOW - WINDOW, (state) => {
      observed = state;
      return "allow";
    });
    expect(result).toEqual({ kind: "claimed" });
    expect(observed).toEqual({ countInWindow: 0, notifyInWindow: 0, converseInWindow: 0 });
  });

  test("claims fold per-class window counts and a window-independent lastSendAt", () => {
    EgressBudgetStore.claim(row("d1", { at: NOW - 90_000 }), NOW - WINDOW, () => "allow");
    EgressBudgetStore.claim(row("d2", { at: NOW - 10_000 }), NOW - WINDOW, () => "allow");
    EgressBudgetStore.claim(
      row("d3", { class: "converse", at: NOW - 5_000 }),
      NOW - WINDOW,
      () => "allow",
    );

    let observed: unknown;
    const probe = EgressBudgetStore.claim(row("probe"), NOW - WINDOW, (state) => {
      observed = state;
      return "inspect" as const;
    });
    expect(probe).toEqual({ kind: "refused", reason: "inspect" });
    expect(observed).toEqual({
      countInWindow: 2,
      notifyInWindow: 1,
      converseInWindow: 1,
      lastSendAt: NOW - 5_000,
    });
  });

  test("claims are isolated per (sender, target) pair", () => {
    EgressBudgetStore.claim(row("a", { targetActorId: "t1" }), NOW - WINDOW, () => "allow");
    EgressBudgetStore.claim(row("b", { targetActorId: "t2" }), NOW - WINDOW, () => "allow");

    let observed: unknown;
    EgressBudgetStore.claim(row("probe", { targetActorId: "other" }), NOW - WINDOW, (state) => {
      observed = state;
      return "inspect" as const;
    });
    expect(observed).toEqual({ countInWindow: 0, notifyInWindow: 0, converseInWindow: 0 });
  });

  test("two contenders for the last SQLite window slot produce exactly one claim", () => {
    const adapter = Storage.get().egressBudget;
    if (adapter === undefined) throw new Error("egress budget adapter missing");

    const results = [row("race-a"), row("race-b")].map((candidate) =>
      adapter.claim(candidate, NOW - WINDOW, (state) => state.countInWindow < 1),
    );

    expect(results).toEqual(["claimed", "refused"]);
  });

  test("retrying a recorded claim is idempotent and never charges the window twice", () => {
    const adapter = Storage.get().egressBudget;
    if (adapter === undefined) throw new Error("egress budget adapter missing");

    const first = row("retry-a");
    expect(adapter.claim(first, NOW - WINDOW, (state) => state.countInWindow < 1)).toBe("claimed");
    expect(adapter.claim(row("retry-b"), NOW - WINDOW, (state) => state.countInWindow < 1)).toBe(
      "refused",
    );
    // The retry short-circuits on the recorded id even under a now-full window.
    expect(adapter.claim(first, NOW - WINDOW, () => false)).toBe("claimed");
  });

  test("retrying an id with different fields is refused as a conflicting claim", () => {
    const adapter = Storage.get().egressBudget;
    if (adapter === undefined) throw new Error("egress budget adapter missing");

    expect(adapter.claim(row("conflict-a"), NOW - WINDOW, () => true)).toBe("claimed");
    const conflicting = { ...row("conflict-a"), targetActorId: "act_someone_else" };
    expect(() => adapter.claim(conflicting, NOW - WINDOW, () => true)).toThrow(
      "already identifies a different claim",
    );
  });

  test("the claim holds one write transaction across read and append", () => {
    // Discriminating atomicity proof: canClaim runs between the projection
    // read and the append. While it runs, a second connection with zero busy
    // timeout must be unable to write — that is only true when the claim
    // opened BEGIN IMMEDIATE before reading. A no-op transaction wrapper
    // would leave the probe insert free to succeed and fail this test.
    const dir = mkdtempSync(join(tmpdir(), "egress-claim-"));
    const dbPath = join(dir, "claim.sqlite");
    Storage.reset();
    Storage.initialize({ dbPath });
    try {
      const adapter = Storage.get().egressBudget;
      if (adapter === undefined) throw new Error("egress budget adapter missing");
      const probe = new Database(dbPath);
      probe.exec("PRAGMA busy_timeout = 0");
      const insertProbeRow = () => {
        probe.exec(
          `INSERT INTO egress_debit (id, sender_id, target_actor_id, class, at, time_created)
           VALUES ('probe', 's', 't', 'notify', ${NOW}, ${NOW})`,
        );
      };

      let probedInsideClaim = false;
      const result = adapter.claim(row("lock-holder"), NOW - WINDOW, () => {
        probedInsideClaim = true;
        expect(insertProbeRow).toThrow(/SQLITE_BUSY|database is locked/);
        return true;
      });

      expect(probedInsideClaim).toBe(true);
      expect(result).toBe("claimed");
      // Once the claim committed, the same probe write is free to proceed.
      insertProbeRow();
      probe.close();
    } finally {
      Storage.reset();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails closed when the sub-adapter is absent", () => {
    Storage.configure({
      transaction: (op: () => unknown) => op(),
      session: {} as never,
      message: {} as never,
      part: {} as never,
    } as never);
    expect(() => EgressBudgetStore.claim(row("missing"), 0, () => "allow")).toThrow(
      "does not implement egressBudget",
    );
  });
});
