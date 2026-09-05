import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LedgerAction, LedgerSession, Storage as ProtocolStorage } from "@openomni/protocol";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";
import { createMemoryL0Adapter } from "../storage/memory-l0-adapter";

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

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
  test("memory and SQLite reject an old fence even when the owner id is unchanged", () => {
    for (const [name, adapter] of kernelStores()) {
      const { sessions } = adapter;
      const sessionId = `session-same-owner-fence-${name}`;
      expect(sessions.create(l0Session(sessionId))).toBe(true);

      expect(
        sessions.acquireLease({
          sessionId,
          owner: "same-owner",
          expectedFence: 0,
          now: 0,
          expiresAt: 30_000,
        }),
      ).toEqual({ ok: true, fence: 1 });
      expect(
        sessions.acquireLease({
          sessionId,
          owner: "same-owner",
          expectedFence: 1,
          now: 1,
          expiresAt: 30_001,
        }),
      ).toEqual({ ok: true, fence: 2 });

      expect(
        sessions.commit({
          sessionId,
          owner: "same-owner",
          fence: 1,
          now: 2,
          expectedRevision: 0,
          actions: [terminalAction(sessionId)],
          consumeInboxIds: [],
          state: "idle",
          releaseLease: true,
        }),
      ).toEqual({
        ok: false,
        reason: "stale",
        currentFence: 2,
        currentRevision: 0,
      });
    }
  });

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

describe("canonical batch rollback", () => {
  test("a refused later action rolls back earlier actions, revision and inbox consumption", () => {
    for (const [name, { sessions, inbox }] of kernelStores()) {
      const sessionId = `rollback-${name}`;
      sessions.create(l0Session(sessionId));
      inbox.commit({
        id: `${sessionId}:input`,
        sessionId,
        kind: "prompt",
        content: "preserve",
        origin: { encodingVersion: 1, value: {} },
        createdAt: 1,
        parentActionId: null,
      });
      sessions.acquireLease({
        sessionId,
        owner: "owner",
        expectedFence: 0,
        now: 2,
        expiresAt: 100,
      });
      const before = sessions.get(sessionId);
      const pending = inbox.list(sessionId);
      const first = { ...terminalAction(sessionId), ts: 3 };
      const refused = { ...first, id: `${sessionId}:refused`, parentId: "missing-parent" };
      expect(
        sessions.commit({
          sessionId,
          owner: "owner",
          fence: 1,
          now: 3,
          expectedRevision: 1,
          actions: [first, refused],
          consumeInboxIds: [`${sessionId}:input`],
          state: "idle",
          releaseLease: true,
        })?.ok,
      ).toBe(false);
      expect(sessions.get(sessionId)).toEqual(before);
      expect(inbox.list(sessionId)).toEqual(pending);
    }
  });
});
