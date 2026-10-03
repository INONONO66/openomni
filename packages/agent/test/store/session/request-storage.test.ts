import { sessionTree } from "../helpers/session-tree";
import { expect, test } from "bun:test";
import { useSqliteStores } from "../helpers/storage";
import { expectCommitted, requestFixture, requestStateAction } from "../helpers/request";

const stores = useSqliteStores("request-storage");

test.each([
  "answer",
  "approval",
] as const)("%s retains original invocation and request snapshots across restart", (mode) => {
  const { request, original, commit } = requestFixture(stores.kernel, mode);
  expectCommitted(commit([original, requestStateAction(request)]));
  expect(stores.kernel.requestById("original")).toEqual(request);
  stores.reopen();
  expect(stores.kernel.requestById("original")).toEqual(request);
  expect(
    sessionTree(request.sessionId, stores.session.actions).find(
      (action) => action.id === "original",
    )?.intent,
  ).toEqual(original.intent);
  expect(stores.kernel.requestRows(request.sessionId)).toEqual([request]);
  expect(stores.kernel.requestRows()).toEqual([request]);
});

test("reply snapshots advance current state without changing original history", () => {
  const { request, original, commit } = requestFixture(stores.kernel);
  expectCommitted(commit([original, requestStateAction(request)]));
  const initialTree = sessionTree(request.sessionId, stores.session.actions);
  const terminal = {
    ...request,
    state: "resolved" as const,
    outcome: "answered" as const,
    seenReplyIds: ["reply"],
    replies: [{ replyId: "reply", responderId: "alice", content: "done", receivedAt: 5 }],
  };
  expectCommitted(commit([requestStateAction(terminal, "original:resolution", "answered")]));
  expect(stores.kernel.requestById("original")).toEqual(terminal);
  expect(
    sessionTree(request.sessionId, stores.session.actions).slice(0, initialTree.length),
  ).toEqual(initialTree);
  expect(stores.kernel.requestById("missing")).toBeUndefined();
  const read = stores.kernel.requestById("original");
  if (!read) throw new Error("missing request");
  read.correlation.channelId = "mutated";
  expect(stores.kernel.requestById("original")?.correlation.channelId).toBe("channel");
});

test("duplicate terminal identities and stale revisions leave the entire action tree unchanged", () => {
  const { request, original, commit } = requestFixture(stores.kernel);
  expectCommitted(commit([original, requestStateAction(request)]));
  const terminal = requestStateAction(
    {
      ...request,
      state: "cancelled",
      outcome: "cancelled",
    },
    "original:resolution",
  );
  expectCommitted(commit([terminal]));
  const before = sessionTree(request.sessionId, stores.session.actions);
  const row = stores.kernel.row(request.sessionId);
  expect(() => commit([terminal])).toThrow(expect.objectContaining({ _tag: "CommitRefused" }));
  expect(() => commit([{ ...terminal, id: "loser" }], row.revision - 1)).toThrow(
    expect.objectContaining({
      _tag: "CommitRefused",

      reason: "revision",
    }),
  );
  expect(sessionTree(request.sessionId, stores.session.actions)).toEqual(before);
  expect(stores.kernel.row(request.sessionId)).toEqual(row);
});
