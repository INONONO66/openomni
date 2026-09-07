import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Inbox, LedgerSession, L0Observation, type LedgerAction } from "@openomni/protocol";
import { SessionHandleStore, Storage } from "../../src/index";
import { Bus } from "../helpers/observation";
import { materializeSession } from "../helpers/session";
import { removeSqliteFiles, tempDbPath } from "../helpers/sqlite";

let dbPath: string;
beforeEach(() => {
  dbPath = tempDbPath("message-commit");
  Bus.reset();
  Storage.initialize({ dbPath, observationSink: Bus });
  materializeSession("parent");
  SessionHandleStore.acquireLease({
    sessionId: "parent",
    owner: "sender",
    expectedFence: 0,
    now: 10,
    expiresAt: 100,
  });
});
afterEach(() => {
  Storage.reset();
  Bus.reset();
  removeSqliteFiles(dbPath);
});

function childMessage() {
  const snapshot = SessionHandleStore.generationSnapshot({
    generation: 1,
    revertTo: 0,
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 0,
  });
  return {
    id: "letter",
    sessionId: "child",
    kind: "prompt" as const,
    content: "work",
    origin: { encodingVersion: 1 as const, value: { replyTo: "request" } },
    parentActionId: null,
    createdAt: 20,
    sender: { sessionId: "parent", owner: "sender", fence: 1 },
    limits: { fanout: 8, depth: 4 },
    createSession: LedgerSession.Materialize.parse({
      row: {
        id: "child",
        parentId: "parent",
        role: "worker",
        leaseOwner: null,
        leaseFence: 0,
        leaseExpiresAt: null,
        revision: 0,
        state: "idle",
        toolsGeneration: 1,
        systemHash: snapshot.systemHash,
        policyGeneration: 0,
      },
      initialAction: SessionHandleStore.configureAction({
        id: "child:configure",
        sessionId: "child",
        parentId: null,
        operation: "create",
        snapshot,
        at: 20,
      }),
    }),
  };
}

test("child identity and first inbox are visible together at the commit signal", async () => {
  // Given a fenced sender and a subscriber installed before the commit.
  const observations: string[] = [];
  const observed = Promise.withResolvers<void>();
  const timeout = setTimeout(
    () => observed.reject(new Error("missing inbox commit signal")),
    10_000,
  );
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.sessionId !== "child") return;
    try {
      expect(SessionHandleStore.row("child").parentId).toBe("parent");
      expect(SessionHandleStore.inboxRows("child")).toHaveLength(1);
      observations.push(event.id);
      if (event.id === "letter") observed.resolve();
    } catch (error) {
      observed.reject(error);
    }
  });
  try {
    const committed = SessionHandleStore.commitInbox(childMessage());
    await observed.promise;
    expect(committed.id).toBe("letter");
    expect(observations).toEqual(["child:configure", "letter"]);
  } finally {
    clearTimeout(timeout);
    unsubscribe();
  }
});

test("inbox insertion fault rolls back child configuration and identity", () => {
  // Given an actual SQLite failure at the final write.
  using raw = new Database(dbPath);
  raw.exec(
    "CREATE TRIGGER refuse_letter BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'letter fault'); END",
  );
  // When insertion fails after preparing the child.
  expect(() => SessionHandleStore.commitInbox(childMessage())).toThrow();
  // Then no part of the child is visible.
  expect(SessionHandleStore.listRows().map((row) => row.id)).toEqual(["parent"]);
  expect(SessionHandleStore.tree("child")).toEqual([]);
  expect(SessionHandleStore.inboxRows("child")).toEqual([]);
});

test("stale sender fence refuses child allocation before any write", () => {
  // Given a sender whose fence was superseded.
  SessionHandleStore.acquireLease({
    sessionId: "parent",
    owner: "replacement",
    expectedFence: 1,
    now: 100,
    expiresAt: 200,
  });
  // When the stale sender tries to create a child.
  expect(() => SessionHandleStore.commitInbox(childMessage())).toThrow();
  // Then neither the child nor its inbox exists.
  expect(SessionHandleStore.listRows().map((row) => row.id)).toEqual(["parent"]);
  expect(SessionHandleStore.inboxRows("child")).toEqual([]);
});

test("message id reuse cannot allocate a second child", () => {
  // Given a committed letter.
  SessionHandleStore.commitInbox(childMessage());
  const next = childMessage();
  const reused = {
    ...next,
    sessionId: "second",
    createSession: {
      row: { ...next.createSession.row, id: "second" },
      initialAction: {
        ...next.createSession.initialAction,
        id: "second:configure",
        sessionId: "second",
      },
    },
  };
  // When the source id is reused against a new target.
  expect(() => SessionHandleStore.commitInbox(reused)).toThrow();
  // Then it has not allocated the second child.
  expect(SessionHandleStore.listRows().map((row) => row.id)).toEqual(["child", "parent"]);
  expect(Inbox.Row.parse(SessionHandleStore.inboxRows("child")[0]).id).toBe("letter");
});

test("the commit transaction rechecks fanout and releases capacity after terminal", () => {
  const first = childMessage();
  first.limits.fanout = 1;
  SessionHandleStore.commitInbox(first);
  const second = {
    ...first,
    id: "second-letter",
    sessionId: "second",
    createSession: {
      row: { ...first.createSession.row, id: "second" },
      initialAction: {
        ...first.createSession.initialAction,
        id: "second-config",
        sessionId: "second",
      },
    },
  };
  expect(SessionHandleStore.openChildCount("parent")).toBe(1);
  expect(() => SessionHandleStore.commitInbox(second)).toThrow();
  expect(SessionHandleStore.listRows().map((row) => row.id)).toEqual(["child", "parent"]);
  SessionHandleStore.acquireLease({
    sessionId: "child",
    owner: "worker",
    expectedFence: 0,
    now: 30,
    expiresAt: 100,
  });
  expect(
    SessionHandleStore.commit({
      sessionId: "child",
      owner: "worker",
      fence: 1,
      now: 40,
      expectedRevision: 2,
      consumeInboxIds: ["letter"],
      state: "idle",
      releaseLease: true,
      actions: [
        {
          id: "child-result",
          parentId: "letter",
          sessionId: "child",
          kind: "turn",
          ts: 40,
          irreversible: true,
          intent: { encodingVersion: 1, value: { phase: "terminal", turnId: "child-turn" } },
          effect: {
            encodingVersion: 1,
            value: {
              phase: "terminal",
              turnId: "child-turn",
              kind: "result",
              text: "done",
              boundaryActionId: null,
              resumeCount: 0,
            },
          },
        },
      ],
    }).ok,
  ).toBe(true);
  expect(SessionHandleStore.openChildCount("parent")).toBe(0);
  expect(SessionHandleStore.commitInbox(second).id).toBe("second-letter");
});

test("root configuration and first inbox use the same atomic inbox port", () => {
  const { sender: _sender, ...root } = childMessage();
  root.createSession.row.parentId = null;
  root.createSession.row.role = "resident";
  expect(SessionHandleStore.commitInbox(root).id).toBe("letter");
  expect(SessionHandleStore.row("child").parentId).toBeNull();
  expect(SessionHandleStore.inboxRows("child")).toHaveLength(1);
});

test("a terminal and its parent inbox delivery roll back on the same fault", () => {
  // Given an existing child holding its own fence.
  SessionHandleStore.commitInbox(childMessage());
  SessionHandleStore.acquireLease({
    sessionId: "child",
    owner: "worker",
    expectedFence: 0,
    now: 30,
    expiresAt: 100,
  });
  const terminal: LedgerAction.Append = {
    id: "child:terminal",
    parentId: "letter",
    sessionId: "child",
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "terminal", turnId: "turn" } },
    effect: { encodingVersion: 1, value: { phase: "terminal", kind: "result", text: "done" } },
    irreversible: true,
    ts: 40,
  };
  using raw = new Database(dbPath);
  raw.exec(
    "CREATE TRIGGER refuse_parent BEFORE INSERT ON inbox WHEN NEW.session_id = 'parent' BEGIN SELECT RAISE(ABORT, 'parent fault'); END",
  );
  const request = {
    sessionId: "child",
    owner: "worker",
    fence: 1,
    now: 40,
    expectedRevision: 2,
    actions: [terminal],
    consumeInboxIds: ["letter"],
    state: "idle" as const,
    releaseLease: true,
    deliveries: [
      {
        id: "parent:reply",
        sessionId: "parent",
        kind: "prompt" as const,
        content: "done",
        createdAt: 40,
        parentActionId: null,
        origin: { encodingVersion: 1 as const, value: { replyTo: "request", kind: "result" } },
      },
    ],
  };
  // When the last write in the terminal unit fails.
  expect(() => SessionHandleStore.commit(request)).toThrow();
  // Then terminal, consumption and parent inbox all remain uncommitted.
  expect(SessionHandleStore.tree("child").map((action) => action.id)).toEqual([
    "child:configure",
    "letter",
  ]);
  expect(SessionHandleStore.pendingInbox("child")).toHaveLength(1);
  expect(SessionHandleStore.inboxRows("parent")).toEqual([]);
});
