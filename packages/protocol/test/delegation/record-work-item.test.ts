import { describe, expect, test } from "bun:test";
import { Delegation } from "../../src/index.js";

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

const SETTLED_AT = 1_700_000_030_000;

function settledRecord(
  operation: "ask" | "assign" | "notify",
  settled: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...base,
    operation,
    ...(operation === "assign" ? { workItemId: "wi-1" } : {}),
    ...(operation === "notify" ? { address: { kind: "actor", actorId: "kim" } } : {}),
    status: "settled",
    settled,
    settledAt: SETTLED_AT,
  };
}

describe("Delegation.Record verification terminals belong to assign only (#807)", () => {
  test("verified and unverified are refused on ask and notify", () => {
    for (const operation of ["ask", "notify"] as const) {
      const verified = Delegation.Record.safeParse(
        settledRecord(operation, {
          status: "verified",
          delegationId: "dg-1",
          output: "done",
          at: SETTLED_AT,
          basisRef: "basis-1",
          factIds: ["result-1"],
        }),
      );
      expect(verified.success).toBe(false);
      if (!verified.success) {
        expect(verified.error.issues[0]?.message).toBe(
          "verified and unverified are terminals for assign only",
        );
      }
      expect(
        Delegation.Record.safeParse(
          settledRecord(operation, {
            status: "unverified",
            delegationId: "dg-1",
            output: "done",
            at: SETTLED_AT,
            reason: "not_declared",
            factIds: [],
          }),
        ).success,
      ).toBe(false);
    }
  });

  test("an assign settles verified or unverified, never completed", () => {
    expect(
      Delegation.Record.safeParse(
        settledRecord("assign", {
          status: "verified",
          delegationId: "dg-1",
          output: "done",
          at: SETTLED_AT,
          basisRef: "basis-1",
          factIds: ["result-1"],
        }),
      ).success,
    ).toBe(true);
    expect(
      Delegation.Record.safeParse(
        settledRecord("assign", {
          status: "unverified",
          delegationId: "dg-1",
          output: "done",
          at: SETTLED_AT,
          reason: "verifier_unavailable",
          factIds: [],
        }),
      ).success,
    ).toBe(true);
    const selfReport = Delegation.Record.safeParse(
      settledRecord("assign", {
        status: "completed",
        delegationId: "dg-1",
        output: "I finished it",
        at: SETTLED_AT,
      }),
    );
    expect(selfReport.success).toBe(false);
    if (!selfReport.success) {
      expect(selfReport.error.issues[0]?.message).toBe(
        "completed is the reply to an ask; assigned work settles verified or unverified",
      );
    }
  });

  test("an ask still settles completed", () => {
    expect(
      Delegation.Record.safeParse(
        settledRecord("ask", {
          status: "completed",
          delegationId: "dg-1",
          output: "the answer",
          at: SETTLED_AT,
        }),
      ).success,
    ).toBe(true);
  });
});

describe("Delegation.normalizeLegacyRecord", () => {
  test("a legacy assign+completed row reads back as unverified(legacy_self_report)", () => {
    const legacy = settledRecord("assign", {
      status: "completed",
      delegationId: "dg-1",
      workerRunId: "run-9",
      output: "I finished it",
      at: SETTLED_AT,
      usage: { tokens: 12 },
    });

    const normalized = Delegation.Record.parse(Delegation.normalizeLegacyRecord(legacy));

    expect(normalized.settled).toEqual({
      status: "unverified",
      delegationId: "dg-1",
      workerRunId: "run-9",
      output: "I finished it",
      at: SETTLED_AT,
      reason: "legacy_self_report",
      factIds: [],
      usage: { tokens: 12 },
    });
  });

  test("ask and notify rows pass through byte-identical", () => {
    const rows = [
      settledRecord("ask", {
        status: "completed",
        delegationId: "dg-1",
        output: "the answer",
        at: SETTLED_AT,
      }),
      settledRecord("notify", { status: "sent", delegationId: "dg-1", at: SETTLED_AT }),
      settledRecord("assign", {
        status: "failed",
        delegationId: "dg-1",
        error: "worker exploded",
        at: SETTLED_AT,
      }),
      { ...base, operation: "assign", workItemId: "wi-1" },
    ];
    for (const row of rows) {
      expect(JSON.stringify(Delegation.normalizeLegacyRecord(row))).toBe(JSON.stringify(row));
    }
  });

  test("non-record input is returned untouched — the parser owns rejection", () => {
    for (const raw of [undefined, null, 7, "row", [], {}]) {
      expect(Delegation.normalizeLegacyRecord(raw)).toBe(raw);
    }
  });
});
