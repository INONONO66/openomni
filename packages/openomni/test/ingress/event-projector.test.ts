import { beforeEach, describe, expect, it } from "bun:test";
import type { Ingress, Message } from "@openomni/protocol";
import { Session, Storage } from "@openomni/session";
import { IngressEventProjector } from "../../src/ingress/event-projector";

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
});
