import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Inbox, type LedgerSession } from "@openomni/protocol";
import { LedgerLive, LedgerWrites, SessionHandleStore, SqliteStorageAdapter, Storage } from "../../src";
import { materializeSession } from "../helpers/session";
import { useMemoryStorage } from "../helpers/storage";

useMemoryStorage();

function childMessage(): Inbox.Commit {
  const snapshot = SessionHandleStore.generationSnapshot({
    generation: 1, revertTo: 0, tools: [], system: { preset: "", blocks: [] }, policyGeneration: 0,
  });
  return Inbox.Commit.parse({
    id: "letter", sessionId: "child", kind: "prompt", content: "work",
    origin: { encodingVersion: 1, value: {} }, parentActionId: null, createdAt: 2,
    createSession: {
      row: {
        id: "child", parentId: null, role: "resident", state: "idle", revision: 0,
        leaseOwner: null, leaseFence: 0, leaseExpiresAt: null,
        toolsGeneration: 1, systemHash: snapshot.systemHash, policyGeneration: 0,
      },
      initialAction: SessionHandleStore.configureAction({
        id: "child:configure", sessionId: "child", parentId: null, operation: "create", snapshot, at: 2,
      }),
    },
  });
}

test("LedgerWrites resolves native storage and reports a missing alarm without mutation", () => {
  materializeSession("fixture", null, (_row: LedgerSession.Row) => Effect.gen(function* () {
    const writes = yield* LedgerWrites.pipe(Effect.provide(LedgerLive(Storage.get())));
    expect(Storage.get().sessions).toBe(writes.sessions);
    expect(yield* Effect.flip(writes.alarms.acquire("missing", 0))).toMatchObject({
      _tag: "AlarmRefused", alarmId: "missing", operation: "acquire", reason: "missing",
    });
    expect(writes.alarms.due(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(SessionHandleStore.tree("fixture")).toHaveLength(1);
  }));
});

test("receiving into an absent session refuses admission without recording a receipt", () => {
  materializeSession("fixture", null, (_row: LedgerSession.Row) => Effect.gen(function* () {
    const writes = yield* LedgerWrites.pipe(Effect.provide(LedgerLive(Storage.get())));
    expect(yield* Effect.flip(writes.inbox.receive({
      id: "missing-letter", sessionId: "missing", kind: "prompt", content: "work",
      origin: { encodingVersion: 1, value: {} }, createdAt: 2, parentActionId: null,
    }))).toMatchObject({
      _tag: "InboxCommitRefused", sessionId: "missing", inboxId: "missing-letter", reason: "admission",
    });
    expect(writes.inbox.list("missing")).toEqual([]);
    expect(SessionHandleStore.tree("missing")).toEqual([]);
  }));
});

test.each([
  ["session.configure", "configuration", 1],
  ["prompt", "admission", 2],
] as const)("a refused %s append rolls back the entire child allocation", (_kind: string, reason: string, revision: number) => {
  const storage = new SqliteStorageAdapter(":memory:");
  Storage.reset();
  Storage.configure(storage);
  materializeSession("fixture", null, (_row: LedgerSession.Row) => Effect.gen(function* () {
    storage.testDatabase().run(`CREATE TRIGGER refuse_append BEFORE UPDATE OF revision ON session WHEN NEW.id = 'child' AND NEW.revision = ${revision} BEGIN SELECT RAISE(IGNORE); END`);
    const before = storage.sessions.list();
    expect(yield* Effect.flip(storage.inbox.receive(childMessage()))).toMatchObject({
      _tag: "InboxCommitRefused", sessionId: "child", inboxId: "letter", reason,
    });
    expect(storage.sessions.list()).toEqual(before);
    expect(storage.actions.tree("child")).toEqual([]);
    expect(storage.inbox.list("child")).toEqual([]);
  }));
});
