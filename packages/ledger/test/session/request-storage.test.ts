import { afterEach, beforeEach, expect, test } from "bun:test";
import { SessionHandleStore, Storage } from "../../src/index";
import { tempDbPath, removeSqliteFiles } from "../helpers/sqlite";
import { expectCommitted, requestFixture, requestStateAction } from "../helpers/request";

let path: string;
beforeEach(() => {
  path = tempDbPath("request-storage");
  Storage.initialize({ dbPath: path });
});
afterEach(() => {
  Storage.reset();
  removeSqliteFiles(path);
});

test.each([
  "reply",
  "approval",
] as const)("%s retains original invocation and request snapshots across restart", (mode) => {
  const { request, original, commit } = requestFixture(mode);
  expectCommitted(commit([original, requestStateAction(request)]));
  expect(SessionHandleStore.requestById("original")).toEqual(request);
  Storage.reset();
  Storage.initialize({ dbPath: path });
  expect(SessionHandleStore.requestById("original")).toEqual(request);
  expect(
    SessionHandleStore.tree(request.sessionId).find((action) => action.id === "original")?.intent,
  ).toEqual(original.intent);
  expect(SessionHandleStore.requestRows(request.sessionId)).toEqual([request]);
  expect(SessionHandleStore.requestRows()).toEqual([request]);
});

test("reply snapshots advance current state without changing original history", () => {
  const { request, original, commit } = requestFixture();
  expectCommitted(commit([original, requestStateAction(request)]));
  const initialTree = SessionHandleStore.tree(request.sessionId);
  const terminal = {
    ...request,
    state: "resolved" as const,
    outcome: "answered" as const,
    seenReplyIds: ["reply"],
    replies: [{ replyId: "reply", responderId: "alice", content: "done", receivedAt: 5 }],
  };
  expectCommitted(commit([requestStateAction(terminal, "original:resolution", "reply")]));
  expect(SessionHandleStore.requestById("original")).toEqual(terminal);
  expect(SessionHandleStore.tree(request.sessionId).slice(0, initialTree.length)).toEqual(
    initialTree,
  );
  expect(SessionHandleStore.requestById("missing")).toBeUndefined();
  const read = SessionHandleStore.requestById("original");
  if (!read) throw new Error("missing request");
  read.correlation.channelId = "mutated";
  expect(SessionHandleStore.requestById("original")?.correlation.channelId).toBe("channel");
});

test("duplicate terminal identities and stale revisions leave the entire action tree unchanged", () => {
  const { request, original, commit } = requestFixture();
  expectCommitted(commit([original, requestStateAction(request)]));
  const terminal = requestStateAction(
    {
      ...request,
      state: "cancelled",
      outcome: "cancelled",
    },
    "original:resolution",
    "reply",
  );
  expectCommitted(commit([terminal]));
  const before = SessionHandleStore.tree(request.sessionId);
  const row = SessionHandleStore.row(request.sessionId);
  expect(commit([terminal]).ok).toBe(false);
  expect(commit([{ ...terminal, id: "loser" }], row.revision - 1)).toMatchObject({
    ok: false,
    reason: "revision",
  });
  expect(SessionHandleStore.tree(request.sessionId)).toEqual(before);
  expect(SessionHandleStore.row(request.sessionId)).toEqual(row);
});

test("missing storage capabilities and unknown sessions fail closed", () => {
  Storage.reset();
  Storage.configure({ transaction: (operation) => operation() });
  expect(() => SessionHandleStore.requestRows()).toThrow("sessions");
  expect(() => SessionHandleStore.requestRows("missing")).toThrow("actions");
});
