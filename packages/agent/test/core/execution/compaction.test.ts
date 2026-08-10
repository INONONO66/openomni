import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { InMemoryCompactor } from "../../../src/core/execution/compaction";

let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function makeUserMessage(text: string): Message.WithParts {
  const id = nextId("user-message");
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
    id: nextId("user-part"),
    sessionID,
    messageID: id,
    type: "text",
    text,
  };
  return { info, parts: [part] };
}

function makeAssistantMessage(text: string): Message.WithParts {
  const id = nextId("assistant-message");
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
    id: nextId("assistant-part"),
    sessionID,
    messageID: id,
    type: "text",
    text,
  };
  return { info, parts: [part] };
}

function makeToolAssistantMessage(text: string, callID: string): Message.WithParts {
  const base = makeAssistantMessage(text);
  const toolPart: Message.ToolPart = {
    id: nextId("tool-part"),
    sessionID: "test",
    messageID: base.info.id,
    type: "tool",
    callID,
    tool: "read_file",
    state: {
      status: "completed",
      input: { path: "/tmp/a" },
      output: "file contents",
      title: "read_file",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
  return { info: base.info, parts: [...base.parts, toolPart] };
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

    it("compacts early when reserveTokens would be consumed", () => {
      expect(
        InMemoryCompactor.shouldCompact(751, {
          contextWindowTokens: 1000,
          reserveTokens: 250,
        }),
      ).toBe(true);
      expect(
        InMemoryCompactor.shouldCompact(749, {
          contextWindowTokens: 1000,
          reserveTokens: 250,
        }),
      ).toBe(false);
    });

    it("compacts early when reserveRatio would be consumed", () => {
      expect(
        InMemoryCompactor.shouldCompact(701, {
          contextWindowTokens: 1000,
          reserveRatio: 0.3,
        }),
      ).toBe(true);
      expect(
        InMemoryCompactor.shouldCompact(699, {
          contextWindowTokens: 1000,
          reserveRatio: 0.3,
        }),
      ).toBe(false);
    });

    it("prefers reserveTokens over reserveRatio", () => {
      expect(
        InMemoryCompactor.shouldCompact(751, {
          contextWindowTokens: 1000,
          reserveTokens: 250,
          reserveRatio: 0.5,
        }),
      ).toBe(true);
      expect(
        InMemoryCompactor.shouldCompact(749, {
          contextWindowTokens: 1000,
          reserveTokens: 250,
          reserveRatio: 0.5,
        }),
      ).toBe(false);
    });

    it("normalizes out-of-range reserve values", () => {
      expect(
        InMemoryCompactor.shouldCompact(999, {
          contextWindowTokens: 1000,
          thresholdRatio: 1,
          reserveTokens: -100,
        }),
      ).toBe(false);
      expect(
        InMemoryCompactor.shouldCompact(0, {
          contextWindowTokens: 1000,
          reserveTokens: 1200,
        }),
      ).toBe(true);
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

  describe("commit boundary invariant", () => {
    it("snaps the cutoff back to a user boundary when no summary anchors the kept window", async () => {
      // onSummarize unset (it is optional everywhere): the natural cutoff lands
      // on an assistant message, which no provider accepts as the first
      // message of a conversation. The commit must snap back to the nearest
      // user boundary instead of committing a leading-assistant window.
      const messages = [
        makeUserMessage("u0"),
        makeAssistantMessage("a1"),
        makeUserMessage("u2"),
        makeAssistantMessage("a3"),
        makeUserMessage("u4"),
        makeToolAssistantMessage("a5", "call-1"),
        makeUserMessage("u6"),
        makeAssistantMessage("a7"),
      ];
      const result = await InMemoryCompactor.compact(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 3,
      });
      expect(result.compacted).toBe(true);
      expect(result.messages[0]?.info.role).toBe("user");
      expect(result.removedCount).toBe(4);
      expect(result.messages).toHaveLength(4);
      // The kept tool call and its result travel in the same WithParts message:
      // message-boundary slicing cannot split the pair.
      const toolParts = result.messages.flatMap((message) =>
        message.parts.filter((part): part is Message.ToolPart => part.type === "tool"),
      );
      expect(toolParts).toHaveLength(1);
      expect(toolParts[0]?.state.status).toBe("completed");
    });

    it("fails loudly with a typed error when no valid user boundary exists", async () => {
      // No user message at or before the cutoff: there is no boundary that can
      // anchor the kept window without a summary. Committing anyway would be
      // commit-then-400; the compactor must refuse with a typed error instead.
      const messages = Array.from({ length: 8 }, (_, i) => makeAssistantMessage(`a${i}`));
      let caught: unknown;
      try {
        await InMemoryCompactor.compact(messages, {
          contextWindowTokens: 1000,
          protectRecentMessages: 3,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe("CompactionBoundaryError");
    });

    it("keeps the natural cutoff when a summary user message anchors the window", async () => {
      // Pin: with onSummarize present, the prepended summary user message makes
      // any message-boundary cutoff provider-valid — no snap-back happens.
      const messages = [
        makeUserMessage("u0"),
        makeAssistantMessage("a1"),
        makeUserMessage("u2"),
        makeAssistantMessage("a3"),
        makeUserMessage("u4"),
        makeAssistantMessage("a5"),
        makeUserMessage("u6"),
        makeAssistantMessage("a7"),
      ];
      const result = await InMemoryCompactor.compact(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 3,
        onSummarize: async () => "anchored",
      });
      expect(result.compacted).toBe(true);
      expect(result.removedCount).toBe(5);
      expect(result.messages).toHaveLength(4);
      expect(result.messages[0]?.info.role).toBe("user");
    });

    it("threads the history session id into the summary message", async () => {
      const messages = Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0 ? makeUserMessage(`user ${i}`) : makeAssistantMessage(`assistant ${i}`),
      );
      const result = await InMemoryCompactor.compact(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 4,
        onSummarize: async () => "summary",
      });
      const summary = result.messages[0];
      expect(summary?.info.role).toBe("user");
      // History carries sessionID "test"; the summary must not introduce a
      // foreign session id into the compacted history.
      expect(summary?.info.sessionID).toBe("test");
      expect(summary?.parts[0]?.sessionID).toBe("test");
      expect(summary?.parts[0]?.messageID).toBe(summary?.info.id);
    });
  });
});
