import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  LedgerAction,
  LedgerSession,
  Message,
  Storage as ProtocolStorage,
} from "@openomni/protocol";
import { Session } from "../../src/session";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";
import { createMemoryL0Adapter } from "../storage/memory-l0-adapter";

/**
 * Session write discipline (#606 audit follow-up):
 *   1. addMessage's three writes (message row, status, session counters) are
 *      one transaction — a failing session write rolls the message back;
 *   2. addPart fails closed on a missing session, exactly like addMessage;
 *   3. remove()'s manual cascade is one transaction — a failure mid-cascade
 *      leaves the session fully intact, never half-deleted.
 */

function userMessage(sessionID: string, id: string): Message.Info {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test-agent",
    model: { providerID: "test", modelID: "test-model" },
  };
}

function textPart(sessionID: string, messageID: string, id: string): Message.TextPart {
  return { id, sessionID, messageID, type: "text", text: "content", time: { start: 1 } };
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

function createSession(title: string) {
  return Session.create({
    traceId: "trace-write-discipline",
    title,
    model: { providerID: "test", modelID: "test-model" },
  });
}

type KernelSessionStore = ProtocolStorage.SessionLedgerSubAdapter;

interface KernelAdapter {
  readonly sessions: KernelSessionStore;
  readonly inbox: ProtocolStorage.InboxSubAdapter;
}

function kernelStores(): Array<readonly [string, KernelAdapter]> {
  const sqliteSessions = Storage.get().sessions;
  const sqliteInbox = Storage.get().inbox;
  if (sqliteSessions === undefined || sqliteInbox === undefined) {
    throw new Error("SQLite kernel session adapters are missing");
  }
  const memory = createMemoryL0Adapter();
  return [
    ["memory", { sessions: memory.sessions as KernelSessionStore, inbox: memory.inbox }],
    ["SQLite", { sessions: sqliteSessions as KernelSessionStore, inbox: sqliteInbox }],
  ];
}

function l0Session(id: string): LedgerSession.Row {
  return {
    id,
    parentId: null,
    role: "resident",
    leaseOwner: null,
    leaseFence: 0,
    leaseExpiresAt: null,
    revision: 0,
    state: "idle",
    toolsGeneration: 0,
    systemHash: "",
    policyGeneration: 0,
  };
}

function terminalAction(sessionId: string): LedgerAction.Append {
  return {
    id: `${sessionId}:result`,
    parentId: null,
    sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "terminal" } },
    effect: { encodingVersion: 1, value: { terminal: "result" } },
    irreversible: true,
    ts: 30_001,
  };
}

describe("fenced session write discipline", () => {
  test("memory and SQLite reject a stale owner after an inclusive-expiry steal", () => {
    for (const [name, adapter] of kernelStores()) {
      const { sessions } = adapter;
      const sessionId = `session-fence-${name}`;
      expect(sessions.create(l0Session(sessionId))).toBe(true);

      expect(
        sessions.acquireLease({
          sessionId,
          owner: "owner-a",
          expectedFence: 0,
          now: 0,
          expiresAt: 30_000,
        }),
      ).toEqual({ ok: true, fence: 1 });
      expect(
        sessions.acquireLease({
          sessionId,
          owner: "owner-b",
          expectedFence: 1,
          now: 29_999,
          expiresAt: 59_999,
        }),
      ).toEqual({
        ok: false,
        reason: "held",
        holder: "owner-a",
        expiresAt: 30_000,
      });
      expect(
        sessions.acquireLease({
          sessionId,
          owner: "owner-b",
          expectedFence: 0,
          now: 30_000,
          expiresAt: 60_000,
        }),
      ).toEqual({ ok: false, reason: "stale", currentFence: 1 });
      expect(
        sessions.acquireLease({
          sessionId,
          owner: "owner-b",
          expectedFence: 1,
          now: 30_000,
          expiresAt: 60_000,
        }),
      ).toEqual({ ok: true, fence: 2 });

      const committed = sessions.commit({
        sessionId,
        owner: "owner-b",
        fence: 2,
        now: 30_001,
        expectedRevision: 0,
        actions: [terminalAction(sessionId)],
        consumeInboxIds: [],
        state: "idle",
        releaseLease: true,
      });
      expect(committed?.ok).toBe(true);
      if (committed?.ok !== true) throw new Error(`${name} terminal commit was refused`);
      expect(committed.row).toMatchObject({ revision: 1, leaseFence: 2, leaseOwner: null });

      expect(
        sessions.commit({
          sessionId,
          owner: "owner-a",
          fence: 1,
          now: 30_001,
          expectedRevision: 0,
          actions: [
            {
              ...terminalAction(sessionId),
              id: `${sessionId}:late-result`,
            },
          ],
          consumeInboxIds: [],
          state: "idle",
          releaseLease: true,
        }),
      ).toEqual({
        ok: false,
        reason: "stale",
        currentFence: 2,
        currentRevision: 1,
      });
    }
  });

  test("memory and SQLite consume one ordered boundary batch with its actions", () => {
    for (const [name, adapter] of kernelStores()) {
      const { sessions, inbox } = adapter;
      const sessionId = `session-boundary-${name}`;
      expect(sessions.create(l0Session(sessionId))).toBe(true);

      const rows = [
        {
          id: `${sessionId}:prompt-1`,
          sessionId,
          kind: "prompt" as const,
          content: "first",
          origin: { encodingVersion: 1 as const, value: { source: "test" } },
          createdAt: 10,
          parentActionId: null,
        },
        {
          id: `${sessionId}:prompt-2`,
          sessionId,
          kind: "prompt" as const,
          content: "second",
          origin: { encodingVersion: 1 as const, value: { source: "test" } },
          createdAt: 11,
          parentActionId: null,
        },
      ];
      for (const row of rows) expect(inbox.commit(row)).toBeDefined();

      const acquired = sessions.acquireLease({
        sessionId,
        owner: "owner",
        expectedFence: 0,
        now: 12,
        expiresAt: 30_012,
      });
      expect(acquired).toEqual({ ok: true, fence: 1 });
      const actions = rows.map(
        (row, index): LedgerAction.Append => ({
          id: `${row.id}:delivery`,
          parentId: index === 0 ? null : `${rows[index - 1]?.id}:delivery`,
          sessionId,
          kind: "inbox.deliver",
          intent: { encodingVersion: 1, value: { inboxId: row.id } },
          effect: { encodingVersion: 1, value: { content: row.content } },
          irreversible: true,
          ts: 12,
        }),
      );
      actions.push({
        id: `${sessionId}:turn`,
        parentId: actions.at(-1)?.id ?? null,
        sessionId,
        kind: "turn",
        intent: { encodingVersion: 1, value: { phase: "intent" } },
        effect: { encodingVersion: 1, value: { resultId: `${sessionId}:result` } },
        irreversible: true,
        ts: 12,
      });

      const committed = sessions.commit({
        sessionId,
        owner: "owner",
        fence: 1,
        now: 12,
        expectedRevision: 2,
        actions,
        consumeInboxIds: rows.map((row) => row.id),
        state: "running",
        releaseLease: false,
      });
      expect(committed?.ok).toBe(true);
      if (committed?.ok !== true) throw new Error(`${name} boundary commit was refused`);
      expect(committed.row).toMatchObject({ revision: 5, state: "running", leaseOwner: "owner" });
      expect(inbox.list(sessionId).map((row) => [row.id, row.status])).toEqual([
        [`${sessionId}:prompt-1`, "consumed"],
        [`${sessionId}:prompt-2`, "consumed"],
      ]);
    }
  });
});

describe("session write discipline", () => {
  test("addMessage is atomic: a failing session write rolls the message back", () => {
    const session = createSession("atomic-add");
    const adapter = Storage.get();
    const realSessionSet = adapter.session.set.bind(adapter.session);
    Storage.configure({
      ...adapter,
      transaction: adapter.transaction.bind(adapter),
      session: {
        ...adapter.session,
        set: (id, info) => {
          if (info.messageCount === 1) throw new Error("session write refused");
          realSessionSet(id, info);
        },
      },
    });

    expect(() => Session.addMessage(session.id, userMessage(session.id, "msg-atomic"))).toThrow(
      "session write refused",
    );
    // The message row committed BEFORE the session write — the transaction
    // must have rolled it back with the failure.
    expect(Session.getMessages(session.id)).toEqual([]);
  });

  test("addPart refuses a part for a missing session", () => {
    expect(() => textPartInsert("no-such-session")).toThrow(
      "addPart: session not found: no-such-session",
    );

    function textPartInsert(sessionID: string): void {
      Session.addPart("msg-none", textPart(sessionID, "msg-none", "part-none"));
    }
  });

  test("remove() cascades every part and its owning message", () => {
    const session = createSession("successful-remove");
    Session.addMessage(session.id, userMessage(session.id, "msg-success"));
    Session.addPart("msg-success", textPart(session.id, "msg-success", "part-success"));

    expect(Session.remove(session.id, "trace-write-discipline")).toBe(true);
    expect(Session.get(session.id)).toBeUndefined();
    expect(Storage.get().message.get(session.id, "msg-success")).toBeUndefined();
    expect(Storage.get().part.get("msg-success", "part-success")).toBeUndefined();
  });

  test("remove() is atomic: a failure mid-cascade leaves the session intact", () => {
    const session = createSession("atomic-remove");
    Session.addMessage(session.id, userMessage(session.id, "msg-1"));
    Session.addPart("msg-1", textPart(session.id, "msg-1", "part-1"));
    Session.addPart("msg-1", textPart(session.id, "msg-1", "part-2"));

    const adapter = Storage.get();
    const realPartRemove = adapter.part.remove.bind(adapter.part);
    let removals = 0;
    Storage.configure({
      ...adapter,
      transaction: adapter.transaction.bind(adapter),
      part: {
        ...adapter.part,
        remove: (messageID, partID) => {
          removals += 1;
          if (removals === 2) throw new Error("cascade interrupted");
          return realPartRemove(messageID, partID);
        },
      },
    });

    expect(() => Session.remove(session.id, "trace-write-discipline")).toThrow(
      "cascade interrupted",
    );
    // Nothing half-deleted: the first part's removal rolled back with the rest.
    expect(Session.get(session.id)?.id).toBe(session.id);
    expect(Session.getMessages(session.id)).toHaveLength(1);
    expect(Session.getParts("msg-1")).toHaveLength(2);
  });
});
