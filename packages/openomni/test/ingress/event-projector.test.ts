import { beforeEach, describe, expect, it } from "bun:test";
import type { ExecutionEvent, Ingress, Message } from "@openomni/protocol";
import { EventLog, Session, Storage } from "@openomni/session";
import { IngressEventProjector } from "../../src/ingress/event-projector";

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

describe("IngressEventProjector", () => {
  let sessionId: string;

  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    sessionId = Session.create({
      title: "Test Session",
      model: { providerID: "anthropic", modelID: "claude-3-haiku" },
    }).id;
  });

  it("should store TextPart with string payload verbatim", () => {
    const event: Ingress.InboundEvent = {
      id: "event-1",
      surface: "slack",
      mode: "direct",
      payload: "Hello, world!",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku" },
      },
    };

    IngressEventProjector.project(event, sessionId, {
      providerID: "anthropic",
      modelID: "claude-3-haiku",
    });

    const messages = Session.getMessages(sessionId);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");

    const parts = Session.getParts(messages[0].id);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("text");
    expect((parts[0] as Message.TextPart).text).toBe("Hello, world!");
  });

  it("should extract text field from object payload", () => {
    const event: Ingress.InboundEvent = {
      id: "event-2",
      surface: "discord",
      mode: "direct",
      payload: { text: "Message from Discord", author: "user123" },
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku" },
      },
    };

    IngressEventProjector.project(event, sessionId, {
      providerID: "anthropic",
      modelID: "claude-3-haiku",
    });

    const messages = Session.getMessages(sessionId);
    const parts = Session.getParts(messages[0].id);
    expect((parts[0] as Message.TextPart).text).toBe("Message from Discord");
  });

  it("should JSON.stringify object payload without text field", () => {
    const payload = { type: "reaction", emoji: "👍", count: 5 };
    const event: Ingress.InboundEvent = {
      id: "event-3",
      surface: "telegram",
      mode: "direct",
      payload,
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku" },
      },
    };

    IngressEventProjector.project(event, sessionId, {
      providerID: "anthropic",
      modelID: "claude-3-haiku",
    });

    const messages = Session.getMessages(sessionId);
    const parts = Session.getParts(messages[0].id);
    expect((parts[0] as Message.TextPart).text).toBe(JSON.stringify(payload));
  });

  it("should set UserMessage.agent to event.surface", () => {
    const event: Ingress.InboundEvent = {
      id: "event-4",
      surface: "whatsapp",
      mode: "direct",
      payload: "Test message",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku" },
      },
    };

    IngressEventProjector.project(event, sessionId, {
      providerID: "anthropic",
      modelID: "claude-3-haiku",
    });

    const messages = Session.getMessages(sessionId);
    expect((messages[0] as Message.UserMessage).agent).toBe("whatsapp");
    expect(messages[0].role).toBe("user");
  });

  it("should store both UserMessage and TextPart in session", () => {
    const event: Ingress.InboundEvent = {
      id: "event-5",
      surface: "email",
      mode: "direct",
      payload: "Email body content",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku" },
      },
    };

    IngressEventProjector.project(event, sessionId, {
      providerID: "anthropic",
      modelID: "claude-3-haiku",
    });

    // Verify UserMessage is stored
    const messages = Session.getMessages(sessionId);
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message.role).toBe("user");
    expect(message.sessionID).toBe(sessionId);

    // Verify TextPart is stored with correct references
    const parts = Session.getParts(message.id);
    expect(parts).toHaveLength(1);
    const part = parts[0] as Message.TextPart;
    expect(part.type).toBe("text");
    expect(part.messageID).toBe(message.id);
    expect(part.sessionID).toBe(sessionId);
    expect(part.text).toBe("Email body content");
  });

  it("should write ingress-local EventLog envelopes before persisted user writes", async () => {
    const event: Ingress.InboundEvent = {
      id: "event-ledger",
      surface: "discord",
      channel: "channel-1",
      workspace: "workspace-1",
      userId: "user-1",
      mode: "direct",
      payload: "Ledger visible text",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku" },
      },
    };

    IngressEventProjector.project(event, sessionId, {
      providerID: "anthropic",
      modelID: "claude-3-haiku",
    });

    const messages = Session.getMessages(sessionId);
    const message = messages[0] as Message.UserMessage;
    const part = Session.getParts(message.id)[0] as Message.TextPart;
    const events = await replayEvents(sessionId);

    expect(events).toHaveLength(5);
    expect(events.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events.every((row) => row.visibility === "internal")).toBe(true);
    expect(events.every((row) => Date.parse(row.timestamp) > 0)).toBe(true);

    const ingressEvents = filterBusEvents(events, "ingress.inbound.");
    expect(ingressEvents.map((row) => row.name)).toEqual([
      "ingress.inbound.project",
      "ingress.inbound.message.write",
      "ingress.inbound.part.write",
    ]);

    const inbound = expectBusEvent(ingressEvents[0], "ingress.inbound.project");
    const messageWrite = expectBusEvent(ingressEvents[1], "ingress.inbound.message.write");
    const partWrite = expectBusEvent(ingressEvents[2], "ingress.inbound.part.write");
    expect(messageWrite.parentActionId).toBe(inbound.actionId);
    expect(partWrite.parentActionId).toBe(messageWrite.actionId);

    const sessionMessage = findBusEvent(events, "session.message.added");
    const sessionPart = findBusEvent(events, "session.part.added");
    expect(sessionPart.parentActionId).toBe(sessionMessage.actionId);
    expect(expectPayload(sessionMessage)).toMatchObject({
      sessionId,
      messageId: message.id,
      role: "user",
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

    expect(expectPayload(inbound)).toMatchObject({
      sessionId,
      eventId: event.id,
      mode: "direct",
      source: "discord",
      messageId: message.id,
      partId: part.id,
      role: "user",
    });
    expect(expectPayload(partWrite)).toMatchObject({
      sessionId,
      eventId: event.id,
      messageId: message.id,
      partId: part.id,
      partType: "text",
    });
    expect(messages).toHaveLength(1);
    expect(part.text).toBe("Ledger visible text");
  });
});
