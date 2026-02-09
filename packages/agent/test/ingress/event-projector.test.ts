import { describe, it, expect, beforeEach } from "bun:test";
import {
  EventProjector,
  DefaultEventProjector,
} from "../../src/ingress/event-projector";
import { Envelope } from "../../src/loop/envelope";
import { Session } from "@openomni/session";
import { Message } from "@openomni/protocol";

describe("EventProjector", () => {
  beforeEach(() => {
    Session.storage.clear();
  });

  it("DefaultEventProjector creates UserMessage with correct id from eventId", () => {
    const event = Envelope.create("test.event", {
      type: "slack",
      id: "workspace:channel:C123",
    });

    const session = Session.create({
      title: "Test Session",
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
    });

    const defaultModel = {
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet-20241022",
    };
    DefaultEventProjector.project(event, session.id, defaultModel);

    const messages = Session.getMessages(session.id);
    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe(event.eventId);
  });

  it("DefaultEventProjector sets role to 'user'", () => {
    const event = Envelope.create("test.event", {
      type: "slack",
      id: "workspace:channel:C123",
    });

    const session = Session.create({
      title: "Test Session",
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
    });

    const defaultModel = {
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet-20241022",
    };
    DefaultEventProjector.project(event, session.id, defaultModel);

    const messages = Session.getMessages(session.id);
    expect(messages[0].role).toBe("user");
  });

  it("DefaultEventProjector sets agent from event.source.type", () => {
    const event = Envelope.create("test.event", {
      type: "telegram",
      id: "botId:chat:chatId",
    });

    const session = Session.create({
      title: "Test Session",
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
    });

    const defaultModel = {
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet-20241022",
    };
    DefaultEventProjector.project(event, session.id, defaultModel);

    const messages = Session.getMessages(session.id);
    expect(messages[0].agent).toBe("telegram");
  });

  it("DefaultEventProjector uses provided defaultModel", () => {
    const event = Envelope.create("test.event", {
      type: "slack",
      id: "workspace:channel:C123",
    });

    const session = Session.create({
      title: "Test Session",
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
    });

    const customModel = { providerID: "openai", modelID: "gpt-4" };
    DefaultEventProjector.project(event, session.id, customModel);

    const messages = Session.getMessages(session.id);
    const userMsg = messages[0] as Message.UserMessage;
    expect(userMsg.model.providerID).toBe("openai");
    expect(userMsg.model.modelID).toBe("gpt-4");
  });

  it("DefaultEventProjector sets time.created from event.receivedAt", () => {
    const event = Envelope.create("test.event", {
      type: "slack",
      id: "workspace:channel:C123",
    });

    const session = Session.create({
      title: "Test Session",
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
    });

    const defaultModel = {
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet-20241022",
    };
    DefaultEventProjector.project(event, session.id, defaultModel);

    const messages = Session.getMessages(session.id);
    const expectedTime = new Date(event.receivedAt).getTime();
    expect(messages[0].time.created).toBe(expectedTime);
  });

  it("custom projector can be injected and called", () => {
    const event = Envelope.create("test.event", {
      type: "slack",
      id: "workspace:channel:C123",
    });

    const session = Session.create({
      title: "Test Session",
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
    });

    let projectCalled = false;
    let capturedEvent: any;
    let capturedSessionId: string = "";
    let capturedModel: any;

    const customProjector: EventProjector = {
      project(evt, sid, model) {
        projectCalled = true;
        capturedEvent = evt;
        capturedSessionId = sid;
        capturedModel = model;
      },
    };

    const defaultModel = {
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet-20241022",
    };
    customProjector.project(event, session.id, defaultModel);

    expect(projectCalled).toBe(true);
    expect(capturedEvent.eventId).toBe(event.eventId);
    expect(capturedSessionId).toBe(session.id);
    expect(capturedModel.providerID).toBe("anthropic");
  });

  it("DefaultEventProjector creates message with sessionID matching session.id", () => {
    const event = Envelope.create("test.event", {
      type: "slack",
      id: "workspace:channel:C123",
    });

    const session = Session.create({
      title: "Test Session",
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
    });

    const defaultModel = {
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet-20241022",
    };
    DefaultEventProjector.project(event, session.id, defaultModel);

    const messages = Session.getMessages(session.id);
    const userMsg = messages[0] as Message.UserMessage;
    expect(userMsg.sessionID).toBe(session.id);
  });
});
