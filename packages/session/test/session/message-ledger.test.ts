import { beforeEach, describe, expect, test } from "bun:test";
import { ExecutionEvent, type Message } from "@openomni/protocol";
import { Session } from "../../src/session/index";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";

function makeUserMessage(sessionID: string, id = "msg-1"): Message.UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test-agent",
    model: { providerID: "test", modelID: "test-model" },
  };
}

function makeTextPart(sessionID: string, messageID: string, text = "hello"): Message.TextPart {
  return {
    id: `${messageID}-part-1`,
    sessionID,
    messageID,
    type: "text",
    text,
    time: { start: Date.now() },
  };
}

function parseEvents(sessionId: string): ExecutionEvent[] {
  const eventLog = Storage.get().eventLog;
  if (!eventLog) throw new Error("test requires EventLog adapter");

  return eventLog.replay(sessionId).map((row) => ExecutionEvent.Schema.parse(JSON.parse(row.data)));
}

describe("Session message ledger", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("addMessage appends a ledger row before message storage", () => {
    const session = Session.create({
      title: "message ledger",
      model: { providerID: "test", modelID: "test-model" },
    });
    const adapter = Storage.get();
    const eventLog = adapter.eventLog;
    if (!eventLog) throw new Error("test requires EventLog adapter");

    const originalAppend = eventLog.append;
    const message = makeUserMessage(session.id, "msg-ledger");
    eventLog.append = (sessionId, type, data) => {
      expect(sessionId).toBe(session.id);
      expect(type).toBe("bus_event");
      expect(adapter.message.get(session.id, message.id)).toBeUndefined();
      expect(adapter.session.get(session.id)?.messageCount).toBeUndefined();
      return originalAppend(sessionId, type, data);
    };

    Session.addMessage(session.id, message, { status: "received" });

    const events = parseEvents(session.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "bus_event",
      name: "session.message.added",
      actionId: `${session.id}:session.addMessage:${message.id}`,
      visibility: "internal",
      sequence: 1,
      payload: {
        sessionId: session.id,
        messageId: message.id,
        role: "user",
        status: "received",
        providerId: "test",
        modelId: "test-model",
      },
    });
    expect(adapter.message.get(session.id, message.id)).toEqual(message);
    expect(Session.get(session.id)?.messageCount).toBe(1);
  });

  test("addPart appends a ledger row before part storage", () => {
    const session = Session.create({
      title: "part ledger",
      model: { providerID: "test", modelID: "test-model" },
    });
    const adapter = Storage.get();
    const eventLog = adapter.eventLog;
    if (!eventLog) throw new Error("test requires EventLog adapter");

    const message = makeUserMessage(session.id, "msg-with-part");
    Session.addMessage(session.id, message);
    const messageEvent = parseEvents(session.id)[0];
    const originalAppend = eventLog.append;
    const longText = "x".repeat(260);
    const part = makeTextPart(session.id, message.id, longText);

    eventLog.append = (sessionId, type, data) => {
      const event = ExecutionEvent.Schema.parse(JSON.parse(data));
      expect(sessionId).toBe(session.id);
      expect(type).toBe("bus_event");
      expect(event.parentActionId).toBe(messageEvent.actionId);
      expect(adapter.part.get(message.id, part.id)).toBeUndefined();
      return originalAppend(sessionId, type, data);
    };

    Session.addPart(message.id, part);

    const events = parseEvents(session.id);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "bus_event",
      name: "session.part.added",
      actionId: `${session.id}:session.addPart:${message.id}:${part.id}`,
      parentActionId: messageEvent.actionId,
      visibility: "internal",
      sequence: 2,
      payload: {
        sessionId: session.id,
        messageId: message.id,
        partMessageId: message.id,
        partId: part.id,
        partType: "text",
        text: {
          text: longText.slice(0, 240),
          length: 260,
          truncated: true,
        },
      },
    });
    expect(adapter.part.get(message.id, part.id)).toEqual(part);
  });

  test("addMessage fails closed when ledger append fails", () => {
    const session = Session.create({
      title: "message fail closed",
      model: { providerID: "test", modelID: "test-model" },
    });
    const adapter = Storage.get();
    const eventLog = adapter.eventLog;
    if (!eventLog) throw new Error("test requires EventLog adapter");

    const message = makeUserMessage(session.id, "msg-fail");
    let messageSetCalled = false;
    const originalSet = adapter.message.set;
    adapter.message.set = (sessionId, nextMessage) => {
      messageSetCalled = true;
      originalSet(sessionId, nextMessage);
    };
    eventLog.append = () => {
      throw new Error("ledger unavailable");
    };

    expect(() => Session.addMessage(session.id, message)).toThrow("ledger unavailable");
    expect(messageSetCalled).toBe(false);
    expect(adapter.message.get(session.id, message.id)).toBeUndefined();
    expect(Session.get(session.id)?.messageCount).toBeUndefined();
  });

  test("addPart fails closed when ledger append fails", () => {
    const session = Session.create({
      title: "part fail closed",
      model: { providerID: "test", modelID: "test-model" },
    });
    const adapter = Storage.get();
    const eventLog = adapter.eventLog;
    if (!eventLog) throw new Error("test requires EventLog adapter");

    const message = makeUserMessage(session.id, "msg-part-fail");
    Session.addMessage(session.id, message);

    const part = makeTextPart(session.id, message.id);
    let partSetCalled = false;
    const originalSet = adapter.part.set;
    adapter.part.set = (messageId, nextPart) => {
      partSetCalled = true;
      originalSet(messageId, nextPart);
    };
    eventLog.append = () => {
      throw new Error("ledger unavailable");
    };

    expect(() => Session.addPart(message.id, part)).toThrow("ledger unavailable");
    expect(partSetCalled).toBe(false);
    expect(adapter.part.get(message.id, part.id)).toBeUndefined();
  });
});
