import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Gateway, L0Observation, type Inbox } from "@openomni/protocol";
import { SessionHandleStore, Storage } from "../../src/index";
import { Bus } from "../helpers/observation";
import { materializeSession } from "../helpers/session";
import { removeSqliteFiles, tempDbPath } from "../helpers/sqlite";

let dbPath: string;
beforeEach(() => {
  dbPath = tempDbPath("message-deadline");
  Bus.reset();
  Storage.initialize({ dbPath, observationSink: Bus });
  materializeSession("sender");
  const receipt = Storage.get().actions?.append({
    id: "send-action", parentId: "sender:configure", sessionId: "sender", kind: "message",
    intent: { encodingVersion: 1, value: { phase: "intent", messageId: "request" } },
    effect: { encodingVersion: 1, value: { state: "open" } }, irreversible: true, ts: 10,
  }, 1);
  expect(receipt).toBeDefined();
  SessionHandleStore.armMessageDeadline({
    messageId: "request", sessionId: "sender", sourceActionId: "send-action", fireAt: 100,
    createdAt: 10, replyTo: "original",
  });
});
afterEach(() => {
  Storage.reset();
  Bus.reset();
  removeSqliteFiles(dbPath);
});

function reply(at: number): Inbox.Commit {
  return {
    id: "reply", sessionId: "sender", kind: "prompt", content: "answer", createdAt: at,
    parentActionId: null,
    origin: { encodingVersion: 1, value: {
      kind: "external_reply", messageId: "request", sourceActionId: "send-action", replyTo: "original",
    } },
  };
}

function winner() {
  return SessionHandleStore.tree("sender").filter((action) => action.id === "send-action:answer");
}

test("deadline has no early fire and commits one prompt before its signal", async () => {
  const observed = Promise.withResolvers<void>();
  const signalled: string[] = [];
  const timeout = setTimeout(() => observed.reject(new Error("missing timeout commit signal")), 10_000);
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.id !== "send-action:timeout") return;
    try {
      expect(SessionHandleStore.inboxRows("sender")).toHaveLength(1);
      expect(winner()).toHaveLength(1);
      signalled.push(event.id);
      observed.resolve();
    } catch (error) { observed.reject(error); }
  });
  try {
    expect(SessionHandleStore.expireMessageDeadlines(99)).toEqual([]);
    expect(SessionHandleStore.inboxRows("sender")).toEqual([]);
    expect(SessionHandleStore.expireMessageDeadlines(100)).toEqual(["sender"]);
    expect(SessionHandleStore.expireMessageDeadlines(100)).toEqual([]);
    await observed.promise;
    expect(signalled).toEqual(["send-action:timeout"]);
    expect(winner()[0]?.effect.value).toEqual({ state: "timed_out" });
    expect(JSON.parse(SessionHandleStore.inboxRows("sender")[0]?.content ?? "null")).toEqual({
      type: "timeout", messageId: "request", replyTo: "original",
    });
  } finally { clearTimeout(timeout); unsubscribe(); }
});

test("timeout observation runs after the commit is visible on an independent connection", () => {
  const observations: Gateway.MessageObservation[] = [];
  Storage.reset();
  Storage.initialize({ dbPath, observationSink: {
    publish(event, data) {
      if (event.name !== Gateway.MessageObserved.name) return;
      using independent = new Database(dbPath, { readonly: true });
      const visible = independent.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM inbox WHERE id = 'send-action:timeout'").get();
      if (visible?.n !== 1) throw new Error("observation preceded durable commit");
      observations.push(Gateway.MessageObservation.parse(data));
    },
  } });
  SessionHandleStore.expireMessageDeadlines(100);
  expect(observations).toEqual([{ kind: "message.timed_out", messageId: "request", waitedMs: 90 }]);
});

test("an answer wins once and the later alarm records no timeout prompt", () => {
  SessionHandleStore.commitInbox(reply(99));
  expect(SessionHandleStore.expireMessageDeadlines(100)).toEqual([]);
  expect(winner()).toHaveLength(1);
  expect(winner()[0]?.effect.value).toEqual({ state: "answered" });
  expect(SessionHandleStore.inboxRows("sender").map((row) => row.id)).toEqual(["reply"]);
  expect(SessionHandleStore.tree("sender").filter((action) => action.kind === "alarm.fired")).toHaveLength(1);
});

test("a late reply preserves new input without changing the timeout winner", () => {
  SessionHandleStore.commitInbox(reply(100));
  expect(winner()).toHaveLength(1);
  expect(winner()[0]?.effect.value).toEqual({ state: "timed_out" });
  expect(SessionHandleStore.inboxRows("sender").map((row) => row.id)).toEqual(["send-action:timeout", "reply"]);
});

test("timeout insertion fault leaves alarm and answer CAS available for restart", () => {
  using raw = new Database(dbPath);
  raw.exec("CREATE TRIGGER refuse_timeout BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'timeout fault'); END");
  expect(() => SessionHandleStore.expireMessageDeadlines(100)).toThrow();
  expect(winner()).toEqual([]);
  expect(SessionHandleStore.inboxRows("sender")).toEqual([]);
  expect(Storage.get().alarms?.due(100)).toHaveLength(1);
  raw.exec("DROP TRIGGER refuse_timeout");
  Storage.reset();
  Storage.initialize({ dbPath, observationSink: Bus });
  expect(SessionHandleStore.expireMessageDeadlines(100)).toEqual(["sender"]);
  Storage.reset();
  Storage.initialize({ dbPath, observationSink: Bus });
  expect(SessionHandleStore.expireMessageDeadlines(100)).toEqual([]);
  expect(SessionHandleStore.inboxRows("sender")).toHaveLength(1);
});
