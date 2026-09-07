import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LedgerSession, SessionTransition } from "@openomni/protocol";
import { SessionHandleStore, Storage } from "../../src/index";
import { materializeSession } from "../helpers/session";
import { expectCommitted, requestFixture, requestStateAction } from "../helpers/request";
import { removeSqliteFiles, tempDbPath } from "../helpers/sqlite";
import { createMemoryL0Adapter } from "./memory-l0-adapter";

describe.each(["sqlite", "memory"] as const)("%s global request count CAS", (adapter) => {
  let path: string;
  beforeEach(() => {
    path = tempDbPath("request-count-cas");
    if (adapter === "sqlite") Storage.initialize({ dbPath: path });
    else Storage.configure(createMemoryL0Adapter());
  });
  afterEach(() => {
    Storage.reset();
    removeSqliteFiles(path);
  });

  function proposal(request: SessionTransition.Request, count: number): LedgerSession.Commit {
    return {
      sessionId: request.sessionId,
      owner: "writer",
      fence: 1,
      now: 4,
      expectedRevision: SessionHandleStore.row(request.sessionId).revision,
      actions: [requestStateAction(request)],
      consumeInboxIds: [],
      state: "idle",
      releaseLease: false,
      requestCount: { since: 0, count },
    };
  }

  test("another session opening invalidates a proposal without changing its local revision", () => {
    const { request, original, commit } = requestFixture("approval");
    expectCommitted(commit([original]));
    materializeSession("other");
    expect(
      SessionHandleStore.acquireLease({
        sessionId: "other",
        owner: "writer",
        expectedFence: 0,
        now: 2,
        expiresAt: 1002,
      }).ok,
    ).toBe(true);
    const other = { ...request, sessionId: "other", requestId: "other-original" };
    expectCommitted(
      SessionHandleStore.commit({
        ...proposal(other, 0),
        actions: [
          { ...original, id: other.requestId, sessionId: "other", parentId: "other:configure" },
        ],
      }),
    );
    const pending = proposal(request, 0);
    const before = {
      row: SessionHandleStore.row(request.sessionId),
      actions: SessionHandleStore.tree(request.sessionId),
      inbox: SessionHandleStore.inboxRows(request.sessionId),
      alarms: Storage.get().alarms?.due(100),
    };
    expectCommitted(SessionHandleStore.commit(proposal(other, 0)));
    expect(SessionHandleStore.row(request.sessionId)).toEqual(before.row);
    const alarms = Storage.get().alarms?.due(100);
    expect(SessionHandleStore.commit(pending)).toEqual({
      ok: false,
      reason: "revision",
      currentFence: 1,
      currentRevision: before.row.revision,
    });
    expect(SessionHandleStore.row(request.sessionId)).toEqual(before.row);
    expect(SessionHandleStore.tree(request.sessionId)).toEqual(before.actions);
    expect(SessionHandleStore.inboxRows(request.sessionId)).toEqual(before.inbox);
    expect(Storage.get().alarms?.due(100)).toEqual(alarms);
    expect(SessionHandleStore.requestById(request.requestId)).toBeUndefined();
    expectCommitted(
      SessionHandleStore.commit({ ...pending, requestCount: { since: 0, count: 1 } }),
    );
  });

  test("counts latest request and reply snapshots, not historical opens or boundary entries", () => {
    const { request, original, commit } = requestFixture("approval");
    expectCommitted(commit([original, requestStateAction(request)]));
    expectCommitted(commit([requestStateAction(request, "duplicate-open")]));
    expectCommitted(
      SessionHandleStore.commit({
        ...proposal(request, 1),
        actions: [],
      }),
    );
    expectCommitted(
      commit([
        requestStateAction(
          {
            ...request,
            state: "resolved",
            outcome: "answered",
          },
          "resolved",
          "reply",
        ),
      ]),
    );
    expectCommitted(
      SessionHandleStore.commit({
        ...proposal(request, 0),
        actions: [],
      }),
    );
    expectCommitted(commit([requestStateAction(request, "reopened")]));
    expectCommitted(
      SessionHandleStore.commit({
        ...proposal(request, 0),
        actions: [],
        requestCount: { since: request.createdAt, count: 0 },
      }),
    );
    expectCommitted(
      commit([
        requestStateAction(
          {
            ...request,
            mode: "reply",
          },
          "reply-mode",
          "reply",
        ),
      ]),
    );
    expectCommitted(
      SessionHandleStore.commit({
        ...proposal(request, 0),
        actions: [],
      }),
    );
  });
});
