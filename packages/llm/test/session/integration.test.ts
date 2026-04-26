// @ts-ignore - bun test types are provided at runtime
import { describe, it, expect, beforeEach } from "bun:test";
import { Session } from "@openomni/session";
import { type Message, Tool } from "@openomni/protocol";
import { Storage, Bus } from "@openomni/session";
import { Snapshot } from "@openomni/session";

describe("Integration", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    Bus.reset();
    Snapshot.reset();
  });

  it("should handle complete session lifecycle with parts", () => {
    const session = Session.create({
      title: "Integration Test",
      model: { providerID: "openai", modelID: "gpt-4" },
    });

    const userMsg: Message.UserMessage = {
      id: "msg-user-1",
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: "test-agent",
      model: { providerID: "openai", modelID: "gpt-4" },
    };

    Session.addMessage(session.id, userMsg);

    const textPart: Message.TextPart = {
      id: "part-text-1",
      sessionID: session.id,
      messageID: userMsg.id,
      type: "text",
      text: "Hello, world!",
    };

    Session.addPart(userMsg.id, textPart);

    const assistantMsg: Message.AssistantMessage = {
      id: "msg-assistant-1",
      sessionID: session.id,
      role: "assistant",
      time: { created: Date.now() },
      parentID: userMsg.id,
      modelID: "gpt-4",
      providerID: "openai",
      agent: "test-agent",
      path: { cwd: "/test", root: "/test" },
      cost: 0.001,
      tokens: {
        input: 10,
        output: 20,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    };

    Session.addMessage(session.id, assistantMsg);

    const assistantTextPart: Message.TextPart = {
      id: "part-text-2",
      sessionID: session.id,
      messageID: assistantMsg.id,
      type: "text",
      text: "Hello! How can I help?",
      time: { start: Date.now(), end: Date.now() },
    };

    Session.addPart(assistantMsg.id, assistantTextPart);

    expect(Session.getMessages(session.id)).toHaveLength(2);
    expect(Session.getParts(userMsg.id)).toHaveLength(1);
    expect(Session.getParts(assistantMsg.id)).toHaveLength(1);
    expect(Session.getParts(userMsg.id)[0].type).toBe("text");
    expect((Session.getParts(userMsg.id)[0] as Message.TextPart).text).toBe("Hello, world!");
  });

  it("should fire bus events on session changes", async () => {
    const events: unknown[] = [];
    const unsub = Bus.subscribe(Session.Event.Created, (data) => {
      events.push(data);
    });

    Session.create({
      title: "Event Test",
      model: { providerID: "openai", modelID: "gpt-4" },
    });

    await new Promise((resolve) => queueMicrotask(resolve));
    expect(events).toHaveLength(1);
    unsub();
  });

  it("should support snapshot tracking", () => {
    const session = Session.create({
      title: "Snapshot Test",
      model: { providerID: "openai", modelID: "gpt-4" },
    });

    const msg1: Message.UserMessage = {
      id: "msg-1",
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: "test-agent",
      model: { providerID: "openai", modelID: "gpt-4" },
    };

    Session.addMessage(session.id, msg1);
    expect(Session.getMessages(session.id)).toHaveLength(1);

    const snapshotID = Snapshot.track(session.id);
    expect(snapshotID).toBeDefined();
    expect(typeof snapshotID).toBe("string");

    const msg2: Message.UserMessage = {
      id: "msg-2",
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: "test-agent",
      model: { providerID: "openai", modelID: "gpt-4" },
    };

    Session.addMessage(session.id, msg2);
    expect(Session.getMessages(session.id)).toHaveLength(2);

    const diff = Snapshot.diff(session.id, snapshotID);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]).toBe("msg-2");
  });

  it("should validate tool state schemas", () => {
    const pending = Tool.StatePending.parse({
      status: "pending",
      input: { foo: "bar" },
    });
    expect(pending.status).toBe("pending");

    const completed = Tool.StateCompleted.parse({
      status: "completed",
      input: { foo: "bar" },
      output: "result text",
      title: "Test Tool",
      metadata: { key: "value" },
      time: { start: 1000, end: 2000 },
    });
    expect(completed.status).toBe("completed");
    expect(completed.output).toBe("result text");

    expect(() => Tool.State.parse({ status: "invalid" })).toThrow();
  });

  it("should support external storage injection", () => {
    const session = Session.create({
      title: "Before Configure",
      model: { providerID: "openai", modelID: "gpt-4" },
    });

    expect(Session.get(session.id)).toBeDefined();

    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    expect(Session.get(session.id)).toBeUndefined();
  });

  it("should export LLM session types from session index", async () => {
    const mod = await import("../../src/session/index");
    expect(mod.Message).toBeDefined();
    expect(mod.Retry).toBeDefined();
    expect(mod.Processor).toBeDefined();
    expect(mod.Tool).toBeDefined();
    expect(mod.toModelMessages).toBeDefined();
  });
});
