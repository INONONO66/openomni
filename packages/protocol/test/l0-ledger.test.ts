import { describe, expect, test } from "bun:test";
import { Alarm, Inbox, LedgerAction, LedgerSession, PolicyRow } from "../src/index.js";

const payload = { encodingVersion: 1, value: { text: "hello" } } as const;

describe("L0 ledger protocol", () => {
  test("parses every confirmed action kind and enforces terminal exclusivity", () => {
    const kinds = [
      "prompt",
      "turn",
      "llm",
      "attempt",
      "tool",
      "message",
      "inbox.deliver",
      "compaction",
      "alarm.arm",
      "alarm.fired",
      "alarm.paused",
      "session.configure",
      "policy.decision",
    ] as const;

    for (const kind of kinds) {
      expect(
        LedgerAction.Node.parse({
          id: `action-${kind}`,
          parentId: null,
          sessionId: "session-1",
          kind,
          intent: payload,
          effect: payload,
          irreversible: true,
          ts: 100,
          ordinal: 1,
        }).kind,
      ).toBe(kind);
    }

    const base = {
      id: "action-1",
      parentId: null,
      sessionId: "session-1",
      kind: "tool",
      intent: payload,
      effect: payload,
      ts: 100,
      ordinal: 1,
    } as const;
    expect(LedgerAction.Node.safeParse(base).success).toBe(false);
    expect(
      LedgerAction.Node.safeParse({ ...base, revert: payload, irreversible: true }).success,
    ).toBe(false);
  });

  test("parses session, inbox, alarm, and global policy rows", () => {
    expect(
      LedgerSession.Row.parse({
        id: "session-1",
        parentId: null,
        role: "resident",
        leaseOwner: null,
        leaseFence: 0,
        leaseExpiresAt: null,
        revision: 0,
        state: "idle",
      }),
    ).toMatchObject({ role: "resident", revision: 0, state: "idle" });

    expect(
      Inbox.Row.parse({
        id: "inbox-1",
        sessionId: "session-1",
        kind: "prompt",
        content: "hello",
        origin: payload,
        status: "pending",
        consumedBy: null,
        consumedAt: null,
        createdAt: 100,
        ordinal: 1,
      }),
    ).toMatchObject({ kind: "prompt", status: "pending" });

    expect(
      Alarm.Row.parse({
        id: "alarm-1",
        sessionId: "session-1",
        kind: "watch",
        fireAt: 200,
        spec: payload,
        status: "armed",
        createdAt: 100,
        updatedAt: 100,
      }),
    ).toMatchObject({ kind: "watch", status: "armed" });

    expect(
      PolicyRow.Row.parse({
        name: "tool-guard",
        kind: "tool",
        phase: "pre",
        match: payload,
        verdict: payload,
        priority: 10,
        generation: 1,
      }),
    ).toMatchObject({ name: "tool-guard", generation: 1 });
  });
});
