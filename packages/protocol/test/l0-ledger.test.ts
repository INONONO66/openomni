import { describe, expect, test } from "bun:test";
import {
  Alarm,
  canonicalDigest,
  Inbox,
  LedgerAction,
  LedgerSession,
  PolicyRow,
} from "../src/index.js";

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

  test("child inbox materialization requires pinned limits but root admission does not", () => {
    const admission = {
      id: "inbox-1",
      sessionId: "session-1",
      kind: "prompt",
      content: "hello",
      origin: payload,
      createdAt: 100,
    };
    const createSession = {
      row: {
        id: "session-1",
        parentId: null,
        role: "resident",
        leaseOwner: null,
        leaseFence: 0,
        leaseExpiresAt: null,
        revision: 0,
        state: "idle",
      },
      initialAction: {
        id: "configure-1",
        parentId: null,
        sessionId: "session-1",
        kind: "session.configure",
        intent: payload,
        effect: payload,
        irreversible: true,
        ts: 100,
      },
    };
    expect(Inbox.Commit.parse(admission).parentActionId).toBeNull();
    expect(Inbox.Commit.safeParse({ ...admission, createSession }).success).toBe(true);
    const child = {
      ...createSession,
      row: { ...createSession.row, parentId: "parent-1", role: "worker" },
    };
    const refused = Inbox.Commit.safeParse({ ...admission, createSession: child });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map(({ path }) => path)).toEqual([["limits"]]);
    expect(
      Inbox.Commit.safeParse({
        ...admission,
        createSession: child,
        limits: { fanout: 0, depth: 0 },
      }).success,
    ).toBe(true);
  });

  test("watch lifetimes, absolute paths and regular expressions validate at the public boundary", () => {
    const command = { command: "echo hello", description: "command watch" };
    const path = { path: "/tmp/watch", event: "modify", description: "path watch" };
    for (const spec of [command, path]) {
      expect(Alarm.Watch.safeParse(spec).success).toBe(false);
      expect(Alarm.Watch.safeParse({ ...spec, persistent: true, timeout_ms: 1 }).success).toBe(
        false,
      );
      expect(Alarm.Watch.safeParse({ ...spec, persistent: true }).success).toBe(true);
      expect(Alarm.Watch.safeParse({ ...spec, timeout_ms: 1 }).success).toBe(true);
    }
    expect(Alarm.Watch.safeParse({ ...command, persistent: true, filter: "^hello$" }).success).toBe(
      true,
    );
    expect(Alarm.Watch.safeParse({ ...command, persistent: true, filter: undefined }).success).toBe(
      true,
    );
    for (const [spec, field] of [
      [{ ...command, timeout_ms: 1, filter: "[" }, "filter"],
      [{ ...path, persistent: true, path: "relative" }, "path"],
    ] as const) {
      const result = Alarm.Watch.safeParse(spec);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map(({ path: issuePath }) => issuePath)).toEqual([[field]]);
    }
  });

  test("alarm occurrences retain domain-separated delivery identity", () => {
    const id = Alarm.occurrenceId("alarm-1", 1, "source-1");
    expect(id).toBe(canonicalDigest(["alarm.occurrence", "alarm-1", 1, "source-1"]));
    expect(Alarm.occurrenceId("alarm-1", 1, "source-1")).toBe(id);
    expect(Alarm.occurrenceId("alarm-2", 1, "source-1")).not.toBe(id);
    expect(Alarm.occurrenceId("alarm-1", 2, "source-1")).not.toBe(id);
    expect(Alarm.occurrenceId("alarm-1", 1, "source-2")).not.toBe(id);
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
