import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { InMemoryCompactor } from "../../../src/core/execution/compaction";

function makeUserMessage(text: string): Message.WithParts {
  const id = crypto.randomUUID();
  const sessionID = "test";
  const info: Message.UserMessage = {
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "", modelID: "" },
  };
  const part: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "text",
    text,
  };
  return { info, parts: [part] };
}

function makeAssistantMessage(text: string): Message.WithParts {
  const id = crypto.randomUUID();
  const sessionID = "test";
  const info: Message.AssistantMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: "",
    providerID: "",
    agent: "test",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  const part: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "text",
    text,
  };
  return { info, parts: [part] };
}

describe("InMemoryCompactor", () => {
  describe("shouldCompact", () => {
    it("returns false when tokens are below threshold", () => {
      expect(InMemoryCompactor.shouldCompact(700, { contextWindowTokens: 1000 })).toBe(false);
    });

    it("returns true when tokens reach 80% threshold", () => {
      expect(InMemoryCompactor.shouldCompact(800, { contextWindowTokens: 1000 })).toBe(true);
    });

    it("returns true when tokens exceed threshold", () => {
      expect(InMemoryCompactor.shouldCompact(900, { contextWindowTokens: 1000 })).toBe(true);
    });

    it("respects custom thresholdRatio", () => {
      expect(
        InMemoryCompactor.shouldCompact(600, {
          contextWindowTokens: 1000,
          thresholdRatio: 0.5,
        }),
      ).toBe(true);
      expect(
        InMemoryCompactor.shouldCompact(400, {
          contextWindowTokens: 1000,
          thresholdRatio: 0.5,
        }),
      ).toBe(false);
    });
  });

  describe("compact", () => {
    it("does not compact when messages count is within protectRecent", async () => {
      const messages = [makeUserMessage("a"), makeAssistantMessage("b")];
      const result = await InMemoryCompactor.compact(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 6,
      });
      expect(result.compacted).toBe(false);
      expect(result.removedCount).toBe(0);
      expect(result.messages).toHaveLength(2);
    });

    it("removes oldest non-system messages beyond protectRecent", async () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        i % 2 === 0 ? makeUserMessage(`user ${i}`) : makeAssistantMessage(`assistant ${i}`),
      );
      const result = await InMemoryCompactor.compact(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 4,
      });
      expect(result.compacted).toBe(true);
      expect(result.removedCount).toBe(6);
      expect(result.messages).toHaveLength(4);
    });

    it("preserves the most recent messages", async () => {
      const messages = [
        makeUserMessage("old-1"),
        makeAssistantMessage("old-2"),
        makeUserMessage("recent-3"),
        makeAssistantMessage("recent-4"),
        makeUserMessage("recent-5"),
        makeAssistantMessage("recent-6"),
        makeUserMessage("recent-7"),
        makeAssistantMessage("recent-8"),
      ];
      const result = await InMemoryCompactor.compact(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 6,
      });
      expect(result.compacted).toBe(true);
      expect(result.messages).toHaveLength(6);
      const texts = result.messages.flatMap((m) =>
        m.parts.filter((p): p is Message.TextPart => p.type === "text").map((p) => p.text),
      );
      expect(texts).toContain("recent-3");
      expect(texts).not.toContain("old-1");
    });

    it("inserts summary message when onSummarize is provided", async () => {
      const messages = Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0 ? makeUserMessage(`user ${i}`) : makeAssistantMessage(`assistant ${i}`),
      );
      const result = await InMemoryCompactor.compact(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 4,
        onSummarize: async () => "Summary of removed messages",
      });
      expect(result.compacted).toBe(true);
      const allTexts = result.messages.flatMap((m) =>
        m.parts.filter((p): p is Message.TextPart => p.type === "text").map((p) => p.text),
      );
      expect(allTexts.some((t) => t.includes("Summary of removed messages"))).toBe(true);
    });

    it("does not compact when non-system messages are within protectRecent", async () => {
      const messages = [makeUserMessage("a"), makeAssistantMessage("b"), makeUserMessage("c")];
      const result = await InMemoryCompactor.compact(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 6,
      });
      expect(result.compacted).toBe(false);
    });
  });
});
