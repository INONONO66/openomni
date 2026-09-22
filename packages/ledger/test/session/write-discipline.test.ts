import { Effect, Either } from "effect";
import { describe, expect, test } from "bun:test";
import type { LedgerAction, LedgerSession } from "@openomni/protocol";
import { Storage } from "../../src/storage/storage";
import { useMemoryStorage } from "../helpers/storage";

useMemoryStorage();

type KernelSessionStore = NonNullable<Storage.Adapter["sessions"]>;

interface KernelAdapter {
  readonly sessions: KernelSessionStore;
  readonly inbox: NonNullable<Storage.Adapter["inbox"]>;
}

function kernelStores(): Array<readonly [string, KernelAdapter]> {
  const sqliteSessions = Storage.get().sessions;
  const sqliteInbox = Storage.get().inbox;
  if (sqliteSessions === undefined || sqliteInbox === undefined) {
    throw new Error("SQLite kernel session adapters are missing");
  }
  return [["SQLite", { sessions: sqliteSessions, inbox: sqliteInbox }]];
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
  test("SQLite rejects an old fence even when the owner id is unchanged", () => {
    for (const [name, adapter] of kernelStores()) {
      const { sessions } = adapter;
      const sessionId = `session-same-owner-fence-${name}`;
      expect(
        Either.getOrThrowWith(
          Effect.runSync(Effect.either(sessions.create(l0Session(sessionId)))),
          (error) => error,
        ),
      ).toBe(true);

      expect(
        Either.getOrThrowWith(
          Effect.runSync(
            Effect.either(
              sessions.acquireLease({
                sessionId,
                owner: "same-owner",
                expectedFence: 0,
                now: 0,
                expiresAt: 30_000,
              }),
            ),
          ),
          (error) => error,
        ),
      ).toEqual({ ok: true, fence: 1 });
      expect(
        Either.getOrThrowWith(
          Effect.runSync(
            Effect.either(
              sessions.acquireLease({
                sessionId,
                owner: "same-owner",
                expectedFence: 1,
                now: 1,
                expiresAt: 30_001,
              }),
            ),
          ),
          (error) => error,
        ),
      ).toEqual({ ok: true, fence: 2 });

      expect(() =>
        Either.getOrThrowWith(
          Effect.runSync(
            Effect.either(
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
            ),
          ),
          (error) => error,
        ),
      ).toThrow(
        expect.objectContaining({
          _tag: "CommitRefused",

          reason: "fence",
          currentFence: 2,
          currentRevision: 0,
        }),
      );
    }
  });

  test("SQLite rejects a stale owner after an inclusive-expiry steal", () => {
    for (const [name, adapter] of kernelStores()) {
      const { sessions } = adapter;
      const sessionId = `session-fence-${name}`;
      expect(
        Either.getOrThrowWith(
          Effect.runSync(Effect.either(sessions.create(l0Session(sessionId)))),
          (error) => error,
        ),
      ).toBe(true);

      expect(
        Either.getOrThrowWith(
          Effect.runSync(
            Effect.either(
              sessions.acquireLease({
                sessionId,
                owner: "owner-a",
                expectedFence: 0,
                now: 0,
                expiresAt: 30_000,
              }),
            ),
          ),
          (error) => error,
        ),
      ).toEqual({ ok: true, fence: 1 });
      expect(() =>
        Either.getOrThrowWith(
          Effect.runSync(
            Effect.either(
              sessions.acquireLease({
                sessionId,
                owner: "owner-b",
                expectedFence: 1,
                now: 29_999,
                expiresAt: 59_999,
              }),
            ),
          ),
          (error) => error,
        ),
      ).toThrow(
        expect.objectContaining({
          _tag: "LeaseRefused",

          reason: "held",
          holder: "owner-a",
          expiresAt: 30_000,
        }),
      );
      expect(() =>
        Either.getOrThrowWith(
          Effect.runSync(
            Effect.either(
              sessions.acquireLease({
                sessionId,
                owner: "owner-b",
                expectedFence: 0,
                now: 30_000,
                expiresAt: 60_000,
              }),
            ),
          ),
          (error) => error,
        ),
      ).toThrow(expect.objectContaining({ _tag: "LeaseRefused", reason: "stale", fence: 1 }));
      expect(
        Either.getOrThrowWith(
          Effect.runSync(
            Effect.either(
              sessions.acquireLease({
                sessionId,
                owner: "owner-b",
                expectedFence: 1,
                now: 30_000,
                expiresAt: 60_000,
              }),
            ),
          ),
          (error) => error,
        ),
      ).toEqual({ ok: true, fence: 2 });

      const committed = Either.getOrThrowWith(
        Effect.runSync(
          Effect.either(
            sessions.commit({
              sessionId,
              owner: "owner-b",
              fence: 2,
              now: 30_001,
              expectedRevision: 0,
              actions: [terminalAction(sessionId)],
              consumeInboxIds: [],
              state: "idle",
              releaseLease: true,
            }),
          ),
        ),
        (error) => error,
      );
      expect(committed?.ok).toBe(true);
      if (committed?.ok !== true) throw new Error(`${name} terminal commit was refused`);
      expect(committed.row).toMatchObject({ revision: 1, leaseFence: 2, leaseOwner: null });

      expect(() =>
        Either.getOrThrowWith(
          Effect.runSync(
            Effect.either(
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
            ),
          ),
          (error) => error,
        ),
      ).toThrow(
        expect.objectContaining({
          _tag: "CommitRefused",

          reason: "fence",
          currentFence: 2,
          currentRevision: 1,
        }),
      );
    }
  });

  test("SQLite consumes one ordered boundary batch with its actions", () => {
    for (const [name, adapter] of kernelStores()) {
      const { sessions, inbox } = adapter;
      const sessionId = `session-boundary-${name}`;
      expect(
        Either.getOrThrowWith(
          Effect.runSync(Effect.either(sessions.create(l0Session(sessionId)))),
          (error) => error,
        ),
      ).toBe(true);

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
      for (const row of rows)
        expect(
          Either.getOrThrowWith(Effect.runSync(Effect.either(inbox.commit(row))), (error) => error),
        ).toBeDefined();

      const acquired = Either.getOrThrowWith(
        Effect.runSync(
          Effect.either(
            sessions.acquireLease({
              sessionId,
              owner: "owner",
              expectedFence: 0,
              now: 12,
              expiresAt: 30_012,
            }),
          ),
        ),
        (error) => error,
      );
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

      const committed = Either.getOrThrowWith(
        Effect.runSync(
          Effect.either(
            sessions.commit({
              sessionId,
              owner: "owner",
              fence: 1,
              now: 12,
              expectedRevision: 2,
              actions,
              consumeInboxIds: rows.map((row) => row.id),
              state: "running",
              releaseLease: false,
            }),
          ),
        ),
        (error) => error,
      );
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
      Either.getOrThrowWith(
        Effect.runSync(Effect.either(sessions.create(l0Session(sessionId)))),
        (error) => error,
      );
      Either.getOrThrowWith(
        Effect.runSync(
          Effect.either(
            inbox.commit({
              id: `${sessionId}:input`,
              sessionId,
              kind: "prompt",
              content: "preserve",
              origin: { encodingVersion: 1, value: {} },
              createdAt: 1,
              parentActionId: null,
            }),
          ),
        ),
        (error) => error,
      );
      Either.getOrThrowWith(
        Effect.runSync(
          Effect.either(
            sessions.acquireLease({
              sessionId,
              owner: "owner",
              expectedFence: 0,
              now: 2,
              expiresAt: 100,
            }),
          ),
        ),
        (error) => error,
      );
      const before = sessions.get(sessionId);
      const pending = inbox.list(sessionId);
      const first = { ...terminalAction(sessionId), ts: 3 };
      const refused = { ...first, id: `${sessionId}:refused`, parentId: "missing-parent" };
      expect(() =>
        Either.getOrThrowWith(
          Effect.runSync(
            Effect.either(
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
              }),
            ),
          ),
          (error) => error,
        ),
      ).toThrow(expect.objectContaining({ _tag: "CommitRefused", reason: "revision" }));
      expect(sessions.get(sessionId)).toEqual(before);
      expect(inbox.list(sessionId)).toEqual(pending);
    }
  });
});
