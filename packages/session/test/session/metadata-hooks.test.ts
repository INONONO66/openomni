import { describe, expect, test, beforeEach } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Session } from "../../src/session";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";

function makeUserMessage(
  sessionID: string,
  overrides?: Partial<Message.UserMessage>,
): Message.UserMessage {
  return {
    id: crypto.randomUUID(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test-agent",
    model: { providerID: "test", modelID: "test-model" },
    ...overrides,
  };
}

function makeAssistantMessage(
  sessionID: string,
  tokens: { input: number; output: number },
  overrides?: Partial<Message.AssistantMessage>,
): Message.AssistantMessage {
  return {
    id: crypto.randomUUID(),
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "parent-1",
    modelID: "test-model",
    providerID: "test",
    agent: "test-agent",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    ...overrides,
  };
}

describe("Session.addMessage metadata hooks", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  describe("messageCount", () => {
    test("increments messageCount from undefined to 1 on first message", () => {
      const session = Session.create({
        title: "Test",
        model: { providerID: "test", modelID: "test-model" },
      });

      expect(session.messageCount).toBeUndefined();

      Session.addMessage(session.id, makeUserMessage(session.id));

      const updated = Session.get(session.id)!;
      expect(updated.messageCount).toBe(1);
    });

    test("increments messageCount from 1 to 2 on second message", () => {
      const session = Session.create({
        title: "Test",
        model: { providerID: "test", modelID: "test-model" },
      });

      Session.addMessage(session.id, makeUserMessage(session.id));
      Session.addMessage(session.id, makeAssistantMessage(session.id, { input: 10, output: 5 }));

      const updated = Session.get(session.id)!;
      expect(updated.messageCount).toBe(2);
    });

    test("increments for both user and assistant messages", () => {
      const session = Session.create({
        title: "Test",
        model: { providerID: "test", modelID: "test-model" },
      });

      Session.addMessage(session.id, makeUserMessage(session.id));
      Session.addMessage(session.id, makeAssistantMessage(session.id, { input: 10, output: 5 }));
      Session.addMessage(session.id, makeUserMessage(session.id));
      Session.addMessage(session.id, makeAssistantMessage(session.id, { input: 20, output: 10 }));

      const updated = Session.get(session.id)!;
      expect(updated.messageCount).toBe(4);
    });
  });

  describe("tokens accumulation", () => {
    test("does NOT update tokens for user messages", () => {
      const session = Session.create({
        title: "Test",
        model: { providerID: "test", modelID: "test-model" },
      });

      Session.addMessage(session.id, makeUserMessage(session.id));

      const updated = Session.get(session.id)!;
      expect(updated.tokens).toBeUndefined();
    });

    test("accumulates tokens from assistant message when session has no initial tokens", () => {
      const session = Session.create({
        title: "Test",
        model: { providerID: "test", modelID: "test-model" },
      });

      Session.addMessage(session.id, makeAssistantMessage(session.id, { input: 100, output: 50 }));

      const updated = Session.get(session.id)!;
      expect(updated.tokens).toEqual({
        input: 100,
        output: 50,
        total: 150,
      });
    });

    test("accumulates tokens across multiple assistant messages", () => {
      const session = Session.create({
        title: "Test",
        model: { providerID: "test", modelID: "test-model" },
      });

      Session.addMessage(session.id, makeAssistantMessage(session.id, { input: 100, output: 50 }));
      Session.addMessage(session.id, makeAssistantMessage(session.id, { input: 200, output: 80 }));

      const updated = Session.get(session.id)!;
      expect(updated.tokens).toEqual({
        input: 300,
        output: 130,
        total: 430,
      });
    });

    test("user messages between assistants do not affect tokens", () => {
      const session = Session.create({
        title: "Test",
        model: { providerID: "test", modelID: "test-model" },
      });

      Session.addMessage(session.id, makeAssistantMessage(session.id, { input: 100, output: 50 }));
      Session.addMessage(session.id, makeUserMessage(session.id));
      Session.addMessage(session.id, makeAssistantMessage(session.id, { input: 200, output: 80 }));

      const updated = Session.get(session.id)!;
      expect(updated.tokens).toEqual({
        input: 300,
        output: 130,
        total: 430,
      });
    });
  });

  describe("time.updated", () => {
    test("updates time.updated when message is added", () => {
      const session = Session.create({
        title: "Test",
        model: { providerID: "test", modelID: "test-model" },
      });

      const originalUpdated = session.time.updated;

      const before = Date.now();
      Session.addMessage(session.id, makeUserMessage(session.id));
      const after = Date.now();

      const updated = Session.get(session.id)!;
      expect(updated.time.updated).toBeGreaterThanOrEqual(originalUpdated);
      expect(updated.time.updated).toBeGreaterThanOrEqual(before);
      expect(updated.time.updated).toBeLessThanOrEqual(after);
    });
  });

  describe("edge cases", () => {
    test("does not throw when session does not exist", () => {
      const msg = makeUserMessage("nonexistent-session");
      expect(() => Session.addMessage("nonexistent-session", msg)).not.toThrow();
    });

    test("preserves other session fields when updating metadata", () => {
      const session = Session.create({
        title: "Original Title",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: 60000,
      });

      Session.addMessage(session.id, makeAssistantMessage(session.id, { input: 50, output: 25 }));

      const updated = Session.get(session.id)!;
      expect(updated.title).toBe("Original Title");
      expect(updated.model).toEqual({
        providerID: "test",
        modelID: "test-model",
      });
      expect(updated.expiresAt).toBeDefined();
    });
  });
});
