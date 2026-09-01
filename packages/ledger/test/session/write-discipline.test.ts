import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Session } from "../../src/session";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";

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
