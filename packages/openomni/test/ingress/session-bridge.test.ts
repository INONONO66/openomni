import { beforeEach, describe, expect, it } from "bun:test";
import type { ExecutionEvent, Message } from "@openomni/protocol";
import { EventLog, Session, Storage } from "@openomni/session";
import { SessionBridge } from "../../src/ingress/session-bridge";

const TEST_MODEL = { provider: "anthropic", id: "claude-3-haiku" };

function createTestSession(): string {
  return Session.create({
    title: "Test Session",
    model: { providerID: "anthropic", modelID: "claude-3-haiku" },
  }).id;
}

function addUserMessage(sessionId: string, text: string): void {
  const message: Message.UserMessage = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "anthropic", modelID: "claude-3-haiku" },
  };
  Session.addMessage(sessionId, message);

  const part: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: message.id,
    type: "text",
    text,
  };
  Session.addPart(message.id, part);
}

function addAssistantMessage(sessionId: string, text: string): void {
  const message: Message.AssistantMessage = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: "claude-3-haiku",
    providerID: "anthropic",
    agent: "test",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
  Session.addMessage(sessionId, message);

  const part: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: message.id,
    type: "text",
    text,
  };
  Session.addPart(message.id, part);
}

async function replayEvents(sessionId: string): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  for await (const event of EventLog.replay(sessionId)) events.push(event);
  return events;
}

function expectBusEvent(event: ExecutionEvent, name: string): ExecutionEvent.MirroredBusEvent {
  expect(event.type).toBe("bus_event");
  if (event.type !== "bus_event") throw new Error(`Expected bus_event, got ${event.type}`);
  expect(event.name).toBe(name);
  return event;
}

function findBusEvent(events: ExecutionEvent[], name: string): ExecutionEvent.MirroredBusEvent {
  const event = events.find((row) => row.type === "bus_event" && row.name === name);
  if (!event) throw new Error(`Missing bus_event: ${name}`);
  return expectBusEvent(event, name);
}

function filterBusEvents(
  events: ExecutionEvent[],
  prefix: string,
): ExecutionEvent.MirroredBusEvent[] {
  return events.filter(
    (row): row is ExecutionEvent.MirroredBusEvent =>
      row.type === "bus_event" && row.name.startsWith(prefix),
  );
}

function expectPayload(event: ExecutionEvent.MirroredBusEvent): Record<string, unknown> {
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    throw new Error("Expected object payload");
  }
  return Object.fromEntries(Object.entries(event.payload));
}

describe("SessionBridge", () => {
  let sessionId: string;

  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    sessionId = createTestSession();
  });

  describe("buildDirectMessages", () => {
    it("should return messages in chronological order with correct roles", () => {
      addUserMessage(sessionId, "Hello");
      addAssistantMessage(sessionId, "Hi there!");
      addUserMessage(sessionId, "How are you?");
      addAssistantMessage(sessionId, "I'm good!");

      const messages = SessionBridge.buildDirectMessages(sessionId);

      expect(messages).toHaveLength(4);
      expect(messages[0]).toEqual({ role: "user", content: "Hello" });
      expect(messages[1]).toEqual({ role: "assistant", content: "Hi there!" });
      expect(messages[2]).toEqual({ role: "user", content: "How are you?" });
      expect(messages[3]).toEqual({ role: "assistant", content: "I'm good!" });
    });

    it("should return empty array for session with no messages", () => {
      const messages = SessionBridge.buildDirectMessages(sessionId);
      expect(messages).toHaveLength(0);
    });
  });

  describe("storeDirectResult", () => {
    it("should store output string as TextPart in session", () => {
      const output = "Here is the API documentation you requested.";

      SessionBridge.storeDirectResult(sessionId, output, TEST_MODEL);

      const messages = Session.getMessages(sessionId);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("assistant");

      const parts = Session.getParts(messages[0].id);
      expect(parts).toHaveLength(1);
      expect(parts[0].type).toBe("text");
      expect((parts[0] as Message.TextPart).text).toBe(output);
    });

    it("should write linked EventLog envelopes for direct result writeback", async () => {
      const output = "Here is the API documentation you requested.";

      SessionBridge.storeDirectResult(sessionId, output, TEST_MODEL);

      const messages = Session.getMessages(sessionId);
      const message = messages[0] as Message.AssistantMessage;
      const part = Session.getParts(message.id)[0] as Message.TextPart;
      const events = await replayEvents(sessionId);

      expect(events).toHaveLength(5);
      expect(events.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(events.every((row) => Date.parse(row.timestamp) > 0)).toBe(true);

      const writebackEvents = filterBusEvents(events, "ingress.writeback.");
      expect(writebackEvents.map((row) => row.name)).toEqual([
        "ingress.writeback.direct_result",
        "ingress.writeback.message.write",
        "ingress.writeback.part.write",
      ]);

      const writeback = expectBusEvent(writebackEvents[0], "ingress.writeback.direct_result");
      const messageWrite = expectBusEvent(writebackEvents[1], "ingress.writeback.message.write");
      const partWrite = expectBusEvent(writebackEvents[2], "ingress.writeback.part.write");
      expect(messageWrite.parentActionId).toBe(writeback.actionId);
      expect(partWrite.parentActionId).toBe(messageWrite.actionId);

      const sessionMessage = findBusEvent(events, "session.message.added");
      const sessionPart = findBusEvent(events, "session.part.added");
      expect(sessionPart.parentActionId).toBe(sessionMessage.actionId);
      expect(expectPayload(sessionMessage)).toMatchObject({
        sessionId,
        messageId: message.id,
        role: "assistant",
        status: "completed",
        providerId: "anthropic",
        modelId: "claude-3-haiku",
      });
      expect(expectPayload(sessionPart)).toMatchObject({
        sessionId,
        messageId: message.id,
        partMessageId: message.id,
        partId: part.id,
        partType: "text",
      });
      expect(expectPayload(writeback)).toMatchObject({
        sessionId,
        mode: "direct",
        source: "session-bridge",
        messageId: message.id,
        partId: part.id,
        role: "assistant",
      });
      expect(expectPayload(partWrite)).toMatchObject({
        sessionId,
        messageId: message.id,
        partId: part.id,
        partType: "text",
      });
      expect(part.text).toBe(output);
    });
  });
});
