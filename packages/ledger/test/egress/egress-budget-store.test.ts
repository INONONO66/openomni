import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EgressBudgetStore, Storage } from "../../src/index";

/**
 * #219 active-egress debit ledger: append-only record of admitted proactive
 * sends, folded into the window/cooldown projection the pure budget evaluator
 * consumes. Perimeter-domain surface (S8) — written only by the channels send
 * kernel. A missing sub-adapter fails closed.
 */
describe("EgressBudgetStore", () => {
  const NOW = 5_000_000_000_000;
  const WINDOW = 60_000;

  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
  });

  test("an empty ledger reads a zero state", () => {
    const state = EgressBudgetStore.readState("s", "t", NOW - WINDOW);
    expect(state).toEqual({ countInWindow: 0, notifyInWindow: 0, converseInWindow: 0 });
  });

  test("records fold into per-class window counts and a window-independent lastSendAt", () => {
    EgressBudgetStore.record({
      id: "d1",
      senderId: "s",
      targetActorId: "t",
      class: "notify",
      at: NOW - 90_000,
    });
    EgressBudgetStore.record({
      id: "d2",
      senderId: "s",
      targetActorId: "t",
      class: "notify",
      at: NOW - 10_000,
    });
    EgressBudgetStore.record({
      id: "d3",
      senderId: "s",
      targetActorId: "t",
      class: "converse",
      at: NOW - 5_000,
    });

    const state = EgressBudgetStore.readState("s", "t", NOW - WINDOW);
    // d1 is outside the 60s window; d2 + d3 are inside.
    expect(state.countInWindow).toBe(2);
    expect(state.notifyInWindow).toBe(1);
    expect(state.converseInWindow).toBe(1);
    // lastSendAt ignores the window — it is the cooldown clock.
    expect(state.lastSendAt).toBe(NOW - 5_000);
  });

  test("debits are isolated per (sender, target) pair", () => {
    EgressBudgetStore.record({
      id: "a",
      senderId: "s",
      targetActorId: "t1",
      class: "notify",
      at: NOW,
    });
    EgressBudgetStore.record({
      id: "b",
      senderId: "s",
      targetActorId: "t2",
      class: "notify",
      at: NOW,
    });
    expect(EgressBudgetStore.readState("s", "t1", NOW - WINDOW).countInWindow).toBe(1);
    expect(EgressBudgetStore.readState("s", "t2", NOW - WINDOW).countInWindow).toBe(1);
    expect(EgressBudgetStore.readState("s", "other", NOW - WINDOW).countInWindow).toBe(0);
  });

  test("fails closed when the sub-adapter is absent", () => {
    Storage.configure({
      transaction: (op: () => unknown) => op(),
      session: {} as never,
      message: {} as never,
      part: {} as never,
    } as never);
    expect(() => EgressBudgetStore.readState("s", "t", 0)).toThrow(
      "does not implement egressBudget",
    );
  });
});
