import { beforeEach, describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Session, Storage } from "@openomni/session";
import { SessionBridge } from "../../src/ingress/session-bridge";
import { newTraceId } from "@openomni/telemetry";

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

      SessionBridge.storeDirectResult(newTraceId(), sessionId, output, TEST_MODEL);

      const messages = Session.getMessages(sessionId);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("assistant");

      const parts = Session.getParts(messages[0].id);
      expect(parts).toHaveLength(1);
      expect(parts[0].type).toBe("text");
      expect((parts[0] as Message.TextPart).text).toBe(output);
    });
  });
});
