import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, Either } from "effect";
import { LedgerSession } from "@openomni/protocol";
import { SessionHandleStore, Storage } from "../../src/index";
import { runLedgerSync } from "../helpers/effect";
import { expectCommitted, requestFixture, requestStateAction } from "../helpers/request";
import { sessionTree } from "../helpers/session-tree";
import { removeSqliteFiles, tempDbPath } from "../helpers/sqlite";

let dbPath: string;
beforeEach(() => {
  dbPath = tempDbPath("request-alarm-projection");
  Storage.initialize({ dbPath });
});
afterEach(() => {
  Storage.reset();
  removeSqliteFiles(dbPath);
});

function childRequest() {
  const fixture = requestFixture();
  const snapshot = SessionHandleStore.generationSnapshot({
    generation: 1,
    revertTo: 0,
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 0,
  });
  const input: LedgerSession.Commit = {
    sessionId: fixture.request.sessionId,
    owner: "writer",
    fence: fixture.lease.fence,
    now: 4,
    expectedRevision: SessionHandleStore.row(fixture.request.sessionId).revision,
    actions: [fixture.original, requestStateAction(fixture.request)],
    consumeInboxIds: [],
    state: "idle",
    releaseLease: false,
    admit: {
      id: "child:inbox",
      sessionId: "child",
      kind: "prompt",
      content: "work",
      origin: { encodingVersion: 1, value: { requestId: fixture.request.requestId } },
      parentActionId: null,
      createdAt: 4,
      sender: { sessionId: fixture.request.sessionId, owner: "writer", fence: fixture.lease.fence },
      limits: { fanout: 1, depth: 1 },
      createSession: {
        row: LedgerSession.Row.parse({
          id: "child",
          parentId: fixture.request.sessionId,
          role: "worker",
          leaseOwner: null,
          leaseFence: 0,
          leaseExpiresAt: null,
          revision: 0,
          state: "idle",
        }),
        initialAction: SessionHandleStore.configureAction({
          id: "child:configure",
          sessionId: "child",
          parentId: null,
          operation: "create",
          snapshot,
          at: 4,
        }),
      },
    },
  };
  const commit = () =>
    Either.getOrThrowWith(
      runLedgerSync(Effect.either(SessionHandleStore.commitRequestTransition(input))),
      (error) => error,
    );
  return { input, commit };
}

test("request, deadline, child configuration and inbox commit together", () => {
  const { commit } = childRequest();
  const result = expectCommitted(commit());
  expect(result.receipts.map(({ action }) => action.id)).toEqual([
    "original",
    "original:open",
    "child:configure",
    "child:inbox",
  ]);
  using independent = new Database(dbPath, { readonly: true });
  expect(independent.query("SELECT status FROM alarm WHERE id = ?").get("original:deadline"))
    .toEqual({ status: "armed" });
  expect(Storage.get().alarms?.get("original:deadline")).toMatchObject({
    id: "original:deadline",
    sessionId: "request-session",
    kind: "at",
    fireAt: 100,
    spec: { encodingVersion: 1, value: { kind: "request_deadline", requestId: "original" } },
    status: "armed",
    createdAt: 3,
    updatedAt: 4,
  });
  expect(SessionHandleStore.requestById("original")?.state).toBe("open");
  expect(sessionTree("child").map(({ id }) => id)).toEqual(["child:configure", "child:inbox"]);
  expect(SessionHandleStore.inboxRows("child").map(({ id }) => id)).toEqual(["child:inbox"]);
});

test.each([
  { state: "expired", outcome: "outcome_unknown", status: "fired", kind: "request" },
  { state: "cancelled", outcome: "cancelled", status: "cancelled", kind: "request" },
  { state: "resolved", outcome: "answered", status: "cancelled", kind: "reply" },
] as const)("$state projects $status without replacing alarm identity or fence", ({ state, outcome, status, kind }) => {
  const fixture = requestFixture();
  expectCommitted(fixture.commit([fixture.original, requestStateAction(fixture.request)]));
  const alarms = Storage.get().alarms;
  if (alarms === undefined) throw new Error("missing alarm adapter");
  const owned = Either.getOrThrowWith(
    runLedgerSync(Effect.either(alarms.acquire("original:deadline", 0))),
    (error) => error,
  );
  const action = {
    ...requestStateAction({ ...fixture.request, state, outcome }, "original:terminal", kind),
    ts: 100,
  };
  expectCommitted(fixture.commit([action]));
  expect(alarms.get("original:deadline")).toEqual({ ...owned, status, updatedAt: 100 });
  expect(alarms.due(100)).toEqual([]);
});

test("validation after request projection rolls back the deadline and request", () => {
  const { input, commit } = childRequest();
  input.receive = {
    id: "invalid:inbox",
    sessionId: input.sessionId,
    kind: "prompt",
    content: "invalid parent",
    origin: { encodingVersion: 1, value: null },
    createdAt: 4,
    parentActionId: "missing",
  };
  const before = SessionHandleStore.row(input.sessionId);
  const tree = sessionTree(input.sessionId);
  expect(commit).toThrow(expect.objectContaining({ _tag: "CommitRefused", reason: "inbox" }));
  expect(Storage.get().alarms?.get("original:deadline")).toBeUndefined();
  expect(SessionHandleStore.requestById("original")).toBeUndefined();
  expect(SessionHandleStore.row(input.sessionId)).toEqual(before);
  expect(sessionTree(input.sessionId)).toEqual(tree);
  expect(SessionHandleStore.listRows().map(({ id }) => id)).toEqual([input.sessionId]);
  expect(SessionHandleStore.inboxRows(input.sessionId)).toEqual([]);
});

test("last inbox write failure rolls back child, request and deadline together", () => {
  const { input, commit } = childRequest();
  using raw = new Database(dbPath);
  raw.run(`CREATE TRIGGER refuse_inbox BEFORE INSERT ON inbox
    BEGIN SELECT RAISE(ABORT, 'inbox fault'); END`);
  const before = SessionHandleStore.row(input.sessionId);
  const tree = sessionTree(input.sessionId);
  expect(commit).toThrow(expect.objectContaining({ _tag: "ForeignFailure" }));
  expect(Storage.get().alarms?.get("original:deadline")).toBeUndefined();
  expect(SessionHandleStore.requestById("original")).toBeUndefined();
  expect(SessionHandleStore.row(input.sessionId)).toEqual(before);
  expect(sessionTree(input.sessionId)).toEqual(tree);
  expect(SessionHandleStore.listRows().map(({ id }) => id)).toEqual([input.sessionId]);
  expect(SessionHandleStore.inboxRows("child")).toEqual([]);
});
