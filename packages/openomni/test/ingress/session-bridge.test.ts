import { beforeEach, describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Session, Storage } from "@openomni/session";
import { SessionBridge } from "../../src/ingress/session-bridge";
import { newTraceId } from "@openomni/telemetry";

const TEST_MODEL = { provider: "anthropic", id: "claude-3-haiku" };

function createTestSession(): string {
  return Session.create({
    traceId: "trace-session-bridge",
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
      const message = messages[0];
      if (message === undefined) throw new Error("shape");
      expect(message.role).toBe("assistant");

      const parts = Session.getParts(message.id);
      expect(parts).toHaveLength(1);
      expect(parts[0]?.type).toBe("text");
      expect((parts[0] as Message.TextPart).text).toBe(output);
    });
  });

  describe("replacement-record hydration (#702, compaction-design L3)", () => {
    function addAnchor(target: string, body: string, keptMessageIds: string[]): string {
      const message: Message.UserMessage = {
        id: crypto.randomUUID(),
        sessionID: target,
        role: "user",
        time: { created: Date.now() },
        agent: "compaction",
        model: { providerID: "", modelID: "" },
      };
      Session.addMessage(target, message);
      const part: Message.TextPart = {
        id: crypto.randomUUID(),
        sessionID: target,
        messageID: message.id,
        type: "text",
        text: `[Conversation Summary]\n${body}`,
        metadata: { compactionAnchor: true, anchorBody: body, keptMessageIds },
      };
      Session.addPart(message.id, part);
      return message.id;
    }

    function addUser(target: string, text: string): string {
      const message: Message.UserMessage = {
        id: crypto.randomUUID(),
        sessionID: target,
        role: "user",
        time: { created: Date.now() },
        agent: "test",
        model: { providerID: "anthropic", modelID: "claude-3-haiku" },
      };
      Session.addMessage(target, message);
      Session.addPart(message.id, {
        id: crypto.randomUUID(),
        sessionID: target,
        messageID: message.id,
        type: "text",
        text,
      });
      return message.id;
    }

    it("hydrates [anchor, kept forward] instead of the full history", () => {
      addUserMessage(sessionId, "old question");
      addAssistantMessage(sessionId, "old answer");
      const keptUser = addUser(sessionId, "recent question");
      addAnchor(sessionId, "checkpoint body", [keptUser]);

      const window = SessionBridge.buildDirectMessages(sessionId);

      expect(window).toHaveLength(2);
      expect(window[0]?.content).toContain("checkpoint body");
      expect(window[0]?.role).toBe("user");
      expect(window[1]?.content).toBe("recent question");
      // The pre-compaction history did not re-inflate.
      expect(window.some((m) => m.content === "old question")).toBe(false);
    });

    it("includes messages stored after the anchor (post-resume turns)", () => {
      const keptUser = addUser(sessionId, "kept");
      addAnchor(sessionId, "body", [keptUser]);
      addAssistantMessage(sessionId, "post-compaction turn");

      const window = SessionBridge.buildDirectMessages(sessionId);
      expect(window.map((m) => m.content).at(-1)).toBe("post-compaction turn");
      expect(window).toHaveLength(3);
    });

    it("the latest record wins when compaction ran more than once", () => {
      const keptA = addUser(sessionId, "kept-by-first");
      addAnchor(sessionId, "first", [keptA]);
      const keptB = addUser(sessionId, "kept-by-second");
      addAnchor(sessionId, "second", [keptB]);

      const window = SessionBridge.buildDirectMessages(sessionId);
      expect(window[0]?.content).toContain("second");
      expect(window.some((m) => m.content.includes("[Conversation Summary]\nfirst"))).toBe(false);
      expect(window.some((m) => m.content === "kept-by-second")).toBe(true);
      expect(window.some((m) => m.content === "kept-by-first")).toBe(false);
    });

    it("skips kept ids that never reached the store", () => {
      const keptUser = addUser(sessionId, "resolvable");
      addAnchor(sessionId, "body", ["ghost-message-id", keptUser]);

      const window = SessionBridge.buildDirectMessages(sessionId);
      expect(window).toHaveLength(2);
      expect(window[1]?.content).toBe("resolvable");
    });

    it("without a record the full history is unchanged", () => {
      addUserMessage(sessionId, "a");
      addAssistantMessage(sessionId, "b");
      expect(SessionBridge.buildDirectMessages(sessionId)).toHaveLength(2);
    });
  });
});
