import { describe, expect, test } from "bun:test";
import {
  applyAtBoundary,
  changedSince,
  orderByAttention,
} from "../src/renderer/attention";
import { makeSession } from "./helpers/session";

/**
 * The stability rule: a new order is adopted at a focus boundary, never while
 * the Owner is reading. An ordering engine that reflows the list under the
 * cursor costs more attention than it saves, which would defeat its own reason
 * for existing.
 */
const facts = (id: string, createdAt: number) => makeSession({ id, projectId: "p", createdAt });
const before = orderByAttention([facts("a", 2), facts("b", 1)], 10);
const after = orderByAttention([facts("a", 1), facts("b", 2)], 10);

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
    const shrunk = orderByAttention([facts("a", 2)], 10);

    expect(changedSince(before, shrunk)).toBe(1);
  });

  test("Given an identical order, When counting drift, Then nothing is reported", () => {
    expect(changedSince(before, before)).toBe(0);
  });
});
