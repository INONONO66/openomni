import { describe, it, expect, beforeEach } from "bun:test";
import { SessionResolver } from "../../../src/legacy/ingress/session-resolver";
import { Session } from "@openomni/session";
import { SurfaceKey } from "@openomni/session";
import { Envelope } from "../../../src/legacy/dispatch/envelope";

describe("SessionResolver", () => {
  beforeEach(() => {
    Session.storage.clear();
    SurfaceKey.clear();
  });

  it("creates new session for unknown surfaceKey", () => {
    const event = Envelope.create("test.event", {
      type: "slack",
      id: "workspaceA:channel:C123:thread:171000",
    });

    const result = SessionResolver.resolve(event);

    expect(result.isNew).toBe(true);
    expect(result.session).toBeDefined();
    expect(result.session.id).toBeDefined();
    expect(result.session.title).toContain("slack");
  });

  it("returns existing session for known surfaceKey", () => {
    const event1 = Envelope.create("test.event", {
      type: "slack",
      id: "workspaceA:channel:C123:thread:171000",
    });

    const result1 = SessionResolver.resolve(event1);
    expect(result1.isNew).toBe(true);
    const sessionId1 = result1.session.id;

    const event2 = Envelope.create("test.event", {
      type: "slack",
      id: "workspaceA:channel:C123:thread:171000",
    });

    const result2 = SessionResolver.resolve(event2);
    expect(result2.isNew).toBe(false);
    expect(result2.session.id).toBe(sessionId1);
  });

  it("handles TUI surfaceKey format", () => {
    const event = Envelope.create("test.event", {
      type: "tui",
      id: "/Users/ino/Develop/OpenOmni",
    });

    const result = SessionResolver.resolve(event);

    expect(result.isNew).toBe(true);
    expect(result.session.title).toContain("tui");
  });

  it("handles telegram surfaceKey format", () => {
    const event = Envelope.create("test.event", {
      type: "telegram",
      id: "botId:chat:chatId",
    });

    const result = SessionResolver.resolve(event);

    expect(result.isNew).toBe(true);
    expect(result.session.title).toContain("telegram");
  });

  it("writes event content to session as message", () => {
    const event = Envelope.create("test.event", {
      type: "slack",
      id: "workspaceA:channel:C123",
    });

    const result = SessionResolver.resolve(event);
    const messages = Session.getMessages(result.session.id);

    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe(event.eventId);
    expect(messages[0].role).toBe("user");
    expect(messages[0].agent).toBe("slack");
  });

  it("uses custom default model when provided", () => {
    const event = Envelope.create("test.event", {
      type: "slack",
      id: "workspaceA:channel:C123",
    });

    const customModel = {
      providerID: "openai",
      modelID: "gpt-4",
    };

    const result = SessionResolver.resolve(event, customModel);

    expect(result.session.model.providerID).toBe("openai");
    expect(result.session.model.modelID).toBe("gpt-4");
  });

  it("handles source without id", () => {
    const event = Envelope.create("test.event", {
      type: "webhook:default",
    });

    const result = SessionResolver.resolve(event);

    expect(result.isNew).toBe(true);
    expect(result.session.title).toContain("webhook:default");
  });

  it("creates new session when existing session is deleted", () => {
    const event1 = Envelope.create("test.event", {
      type: "slack",
      id: "workspaceA:channel:C123",
    });

    const result1 = SessionResolver.resolve(event1);
    const sessionId1 = result1.session.id;

    Session.remove(sessionId1);

    const event2 = Envelope.create("test.event", {
      type: "slack",
      id: "workspaceA:channel:C123",
    });

    const result2 = SessionResolver.resolve(event2);

    expect(result2.isNew).toBe(true);
    expect(result2.session.id).not.toBe(sessionId1);
  });

  it("registers surfaceKey bidirectionally", () => {
    const event = Envelope.create("test.event", {
      type: "slack",
      id: "workspaceA:channel:C123",
    });

    const result = SessionResolver.resolve(event);
    const surfaceKey = "slack:workspaceA:channel:C123";

    const lookedUpSessionId = SurfaceKey.lookup(surfaceKey);
    expect(lookedUpSessionId).toBe(result.session.id);

    const keys = SurfaceKey.listBySession(result.session.id);
    expect(keys).toContain(surfaceKey);
  });

  it("handles multiple events to same session", () => {
    const event1 = Envelope.create("test.event", {
      type: "slack",
      id: "workspaceA:channel:C123",
    });

    const result1 = SessionResolver.resolve(event1);

    const event2 = Envelope.create("test.event", {
      type: "slack",
      id: "workspaceA:channel:C123",
    });

    const result2 = SessionResolver.resolve(event2);

    expect(result1.session.id).toBe(result2.session.id);

    const messages = Session.getMessages(result1.session.id);
    expect(messages.length).toBe(2);
  });
});
