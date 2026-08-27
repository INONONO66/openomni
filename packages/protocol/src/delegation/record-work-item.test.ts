import { describe, expect, test } from "bun:test";
import { Delegation } from "../index";

const base = {
  delegationId: "dg-1",
  address: { kind: "core", scope: "independent" },
  transport: "process",
  deadline: 1_700_000_060_000,
  rootDelegationId: "dg-1",
  origin: { role: "resident", depth: 0, sessionId: "sess-owner" },
  instruction: "assemble the widget",
  status: "open",
  createdAt: 1_700_000_000_000,
} as const;

describe("Delegation.Record work-item linkage", () => {
  test("an assign record without a workItemId is refused", () => {
    const parsed = Delegation.Record.safeParse({
      ...base,
      operation: "assign",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe(
        "an assign record carries the WorkItem it commissioned",
      );
    }
  });

  test("an assign record with a workItemId parses", () => {
    const parsed = Delegation.Record.safeParse({
      ...base,
      operation: "assign",
      workItemId: "wi-1",
    });
    expect(parsed.success).toBe(true);
  });

  test("a non-assign record carrying a workItemId is refused", () => {
    const parsed = Delegation.Record.safeParse({
      ...base,
      operation: "ask",
      workItemId: "wi-1",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe("only assign commissions a WorkItem");
    }
  });
});
