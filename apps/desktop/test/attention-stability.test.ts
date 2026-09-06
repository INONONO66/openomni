import { describe, expect, test } from "bun:test";
import {
  applyAtBoundary,
  changedSince,
  idleBoundaryReached,
  IDLE_BOUNDARY_MS,
  orderByAttention,
} from "../src/renderer/attention";
import { facts, signals } from "./attention-fixture";

/**
 * The stability rule: a new order is adopted at a focus boundary, never while
 * the Owner is reading. An ordering engine that reflows the list under the
 * cursor costs more attention than it saves, which would defeat its own reason
 * for existing.
 */
const before = orderByAttention(["p"], [facts("a", "running"), facts("b", "running")], signals());
const after = orderByAttention(["p"], [facts("a", "running"), facts("b", "waiting")], signals());

describe("order is applied at a focus boundary only", () => {
  test("Given a new ideal order and no boundary, When applied, Then the shown order is held", () => {
    const held = applyAtBoundary({ shown: before, pendingChanges: 0 }, after, null);

    expect(held.shown).toBe(before);
    expect(held.pendingChanges).toBeGreaterThan(0);
  });

  test("Given each boundary kind, When applied, Then the new order is adopted and the hint clears", () => {
    for (const boundary of ["selection", "idle", "refresh"] as const) {
      const held = applyAtBoundary({ shown: before, pendingChanges: 2 }, after, boundary);

      expect(held.shown).toBe(after);
      expect(held.pendingChanges).toBe(0);
    }
  });

  test("Given the ideal order has not moved, When held, Then no change is reported", () => {
    expect(applyAtBoundary({ shown: before, pendingChanges: 0 }, before, null).pendingChanges).toBe(
      0,
    );
  });
});

describe("drift is counted, never animated", () => {
  test("Given rows swapped, When counting drift, Then both moved rows are reported", () => {
    expect(changedSince(before, after)).toBe(2);
  });

  test("Given a session disappears, When counting drift, Then the loss is reported", () => {
    const shrunk = orderByAttention(["p"], [facts("a", "running")], signals());

    expect(changedSince(before, shrunk)).toBe(1);
  });

  test("Given an identical order, When counting drift, Then nothing is reported", () => {
    expect(changedSince(before, before)).toBe(0);
  });
});

describe("the idle boundary", () => {
  test("Given idle time, When measured against the breakpoint, Then only the full interval qualifies", () => {
    expect(idleBoundaryReached(IDLE_BOUNDARY_MS - 1)).toBe(false);
    expect(idleBoundaryReached(IDLE_BOUNDARY_MS)).toBe(true);
  });

  test("Given the breakpoint, When inspected, Then it is long enough to outlast a keystroke burst", () => {
    // Shorter than this and typing itself becomes a boundary, which is exactly
    // the moment the Owner must not be reordered.
    expect(IDLE_BOUNDARY_MS).toBeGreaterThanOrEqual(1000);
  });
});
