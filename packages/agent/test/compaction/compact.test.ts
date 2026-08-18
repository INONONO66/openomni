import { describe, expect, it } from "bun:test";
import { AgentExecution, type Message } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { Compaction } from "../../src/compaction/compact";

/** Compaction rewrites a run's history; the record carries that run's trace. */
const TEST_TRACE_ID = "trace-compaction-test";

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
  // Realistic bulk: the progress guard (review #721 M1) rightly refuses a
  // cut whose anchor render outweighs what it drops — production assistant
  // turns are never 2 chars, so fixtures must not be either.
  const bulked = `${text}\n${"filler ".repeat(50)}`;
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
    text: bulked,
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

describe("Compaction", () => {
  /**
   * Compaction rewrites the run's history; the record of that has to be
   * readable against the run it changed. Re-minting here left the suite green.
   */
  it("files the compaction record under the run's trace", async () => {
    const seen: Array<{ traceId: string }> = [];
    const unsubStarted = Bus.subscribe(AgentExecution.CompactionStarted, (event) => {
      seen.push(event as unknown as { traceId: string });
    });
    const unsubCompleted = Bus.subscribe(AgentExecution.CompactionCompleted, (event) => {
      seen.push(event as unknown as { traceId: string });
    });

    try {
      await Compaction.compact(
        Array.from({ length: 12 }, (_unused, index) => makeUserMessage(`message ${index}`)),
        { contextWindowTokens: 1000, protectRecentMessages: 2 },
        { traceId: TEST_TRACE_ID, sessionId: "test" },
        Bus,
        { trigger: "threshold" },
      );
      await Bun.sleep(0);
    } finally {
      unsubStarted();
      unsubCompleted();
    }

    // The bracket: started + completed, both filed under the run's trace.
    expect(seen.filter((event) => event.traceId === TEST_TRACE_ID)).toHaveLength(2);
  });

  describe("shouldCompact", () => {
    it("returns false when tokens are below threshold", () => {
      expect(Compaction.shouldCompact(700, { contextWindowTokens: 1000 })).toBe(false);
    });

    it("returns true when tokens reach 80% threshold", () => {
      expect(Compaction.shouldCompact(800, { contextWindowTokens: 1000 })).toBe(true);
    });

    it("returns true when tokens exceed threshold", () => {
      expect(Compaction.shouldCompact(900, { contextWindowTokens: 1000 })).toBe(true);
    });

    it("respects custom thresholdRatio", () => {
      expect(
        Compaction.shouldCompact(600, {
          contextWindowTokens: 1000,
          thresholdRatio: 0.5,
        }),
      ).toBe(true);
      expect(
        Compaction.shouldCompact(400, {
          contextWindowTokens: 1000,
          thresholdRatio: 0.5,
        }),
      ).toBe(false);
    });

    it("compacts early when reserveTokens would be consumed", () => {
      expect(
        Compaction.shouldCompact(751, {
          contextWindowTokens: 1000,
          reserveTokens: 250,
        }),
      ).toBe(true);
      expect(
        Compaction.shouldCompact(749, {
          contextWindowTokens: 1000,
          reserveTokens: 250,
        }),
      ).toBe(false);
    });

    it("compacts early when reserveRatio would be consumed", () => {
      expect(
        Compaction.shouldCompact(701, {
          contextWindowTokens: 1000,
          reserveRatio: 0.3,
        }),
      ).toBe(true);
      expect(
        Compaction.shouldCompact(699, {
          contextWindowTokens: 1000,
          reserveRatio: 0.3,
        }),
      ).toBe(false);
    });

    it("prefers reserveTokens over reserveRatio", () => {
      expect(
        Compaction.shouldCompact(751, {
          contextWindowTokens: 1000,
          reserveTokens: 250,
          reserveRatio: 0.5,
        }),
      ).toBe(true);
      expect(
        Compaction.shouldCompact(749, {
          contextWindowTokens: 1000,
          reserveTokens: 250,
          reserveRatio: 0.5,
        }),
      ).toBe(false);
    });

    it("normalizes out-of-range reserve values", () => {
      expect(
        Compaction.shouldCompact(999, {
          contextWindowTokens: 1000,
          thresholdRatio: 1,
          reserveTokens: -100,
        }),
      ).toBe(false);
      expect(
        Compaction.shouldCompact(0, {
          contextWindowTokens: 1000,
          reserveTokens: 1200,
        }),
      ).toBe(true);
    });
  });

  describe("compact", () => {
    it("does not compact when messages count is within protectRecent", async () => {
      const messages = [makeUserMessage("a"), makeAssistantMessage("b")];
      const result = await Compaction.compact(
        messages,
        {
          contextWindowTokens: 1000,
          protectRecentMessages: 6,
        },
        { traceId: TEST_TRACE_ID, sessionId: "test" },
        Bus,
        { trigger: "threshold" },
      );
      expect(result.compacted).toBe(false);
      expect(result.removedCount).toBe(0);
      expect(result.messages).toHaveLength(2);
    });

    it("removes oldest non-system messages beyond protectRecent", async () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        i % 2 === 0 ? makeUserMessage(`user ${i}`) : makeAssistantMessage(`assistant ${i}`),
      );
      const result = await Compaction.compact(
        messages,
        {
          contextWindowTokens: 1000,
          protectRecentMessages: 4,
        },
        { traceId: TEST_TRACE_ID, sessionId: "test" },
        Bus,
        { trigger: "threshold" },
      );
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
      const result = await Compaction.compact(
        messages,
        {
          contextWindowTokens: 1000,
          protectRecentMessages: 6,
        },
        { traceId: TEST_TRACE_ID, sessionId: "test" },
        Bus,
        { trigger: "threshold" },
      );
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
      const result = await Compaction.compact(
        messages,
        {
          contextWindowTokens: 1000,
          protectRecentMessages: 4,
          onSummarize: async () => "Summary of removed messages",
        },
        { traceId: TEST_TRACE_ID, sessionId: "test" },
        Bus,
        { trigger: "threshold" },
      );
      expect(result.compacted).toBe(true);
      const allTexts = result.messages.flatMap((m) =>
        m.parts.filter((p): p is Message.TextPart => p.type === "text").map((p) => p.text),
      );
      expect(allTexts.some((t) => t.includes("Summary of removed messages"))).toBe(true);
    });

    it("does not compact when non-system messages are within protectRecent", async () => {
      const messages = [makeUserMessage("a"), makeAssistantMessage("b"), makeUserMessage("c")];
      const result = await Compaction.compact(
        messages,
        {
          contextWindowTokens: 1000,
          protectRecentMessages: 6,
        },
        { traceId: TEST_TRACE_ID, sessionId: "test" },
        Bus,
        { trigger: "threshold" },
      );
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
      const result = await Compaction.compact(
        messages,
        {
          contextWindowTokens: 1000,
          protectRecentMessages: 3,
        },
        { traceId: TEST_TRACE_ID, sessionId: "test" },
        Bus,
        { trigger: "threshold" },
      );
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

    it("refuses as a value when no valid user boundary exists — never a throw", async () => {
      // No user message at or before the cutoff: there is no boundary that can
      // anchor the kept window without a summary. The wiring review proved
      // assistant-first histories reachable from resumed worker hydration, and
      // run.completion.pre is fail-closed — a throw here kills a live run over
      // housekeeping. The refusal is a value the policy records.
      const messages = Array.from({ length: 8 }, (_, i) => makeAssistantMessage(`a${i}`));
      const result = await Compaction.compact(
        messages,
        {
          contextWindowTokens: 1000,
          protectRecentMessages: 3,
        },
        { traceId: TEST_TRACE_ID, sessionId: "test" },
        Bus,
        { trigger: "threshold" },
      );
      expect(result.compacted).toBe(false);
      expect(result.blocked).toBe("no_user_boundary");
      expect(result.messages).toHaveLength(8);
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
      const result = await Compaction.compact(
        messages,
        {
          contextWindowTokens: 1000,
          protectRecentMessages: 3,
          onSummarize: async () => "anchored",
        },
        { traceId: TEST_TRACE_ID, sessionId: "test" },
        Bus,
        { trigger: "threshold" },
      );
      expect(result.compacted).toBe(true);
      // L2: the cut span's user messages (u0, u2, u4) survive verbatim, so
      // only the two assistant messages are dropped into the anchor.
      expect(result.removedCount).toBe(2);
      expect(result.messages).toHaveLength(7);
      expect(result.messages[0]?.info.role).toBe("user");
      const texts = result.messages.flatMap((m) =>
        m.parts.filter((p): p is Message.TextPart => p.type === "text").map((p) => p.text),
      );
      expect(texts).toContain("u0");
      expect(texts).toContain("u2");
      expect(texts).toContain("u4");
      expect(texts.some((t) => t.includes("a1"))).toBe(false);
    });

    it("threads the history session id into the summary message", async () => {
      const messages = Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0 ? makeUserMessage(`user ${i}`) : makeAssistantMessage(`assistant ${i}`),
      );
      const result = await Compaction.compact(
        messages,
        {
          contextWindowTokens: 1000,
          protectRecentMessages: 4,
          onSummarize: async () => "summary",
        },
        { traceId: TEST_TRACE_ID, sessionId: "test" },
        Bus,
        { trigger: "threshold" },
      );
      const summary = result.messages[0];
      expect(summary?.info.role).toBe("user");
      // History carries sessionID "test"; the summary must not introduce a
      // foreign session id into the compacted history.
      expect(summary?.info.sessionID).toBe("test");
      expect(summary?.parts[0]?.sessionID).toBe("test");
      expect(summary?.parts[0]?.messageID).toBe(summary?.info.id);
    });
  });

  describe("anchored iterative summarization (L2)", () => {
    const trace = { traceId: TEST_TRACE_ID, sessionId: "test" };
    const opts = { contextWindowTokens: 1000, protectRecentMessages: 2 };

    it("excludes user messages from the summarizer and preserves them byte-exact", async () => {
      const userText = `제약: 절대 요약하지 마라\n${"x".repeat(50)}\t🧭`;
      const seen: Message.WithParts[][] = [];
      const messages = [
        makeUserMessage(userText),
        makeAssistantMessage("a1"),
        makeUserMessage("u2"),
        makeAssistantMessage("a3"),
        makeUserMessage("u4"),
        makeAssistantMessage("a5"),
      ];
      const result = await Compaction.compact(
        messages,
        {
          ...opts,
          onSummarize: async (input) => {
            seen.push(input);
            return "anchor-v1";
          },
        },
        trace,
        Bus,
        { trigger: "threshold" },
      );

      // Summarizer saw assistants only.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.every((m) => m.info.role === "assistant")).toBe(true);
      // Every user message survives byte-exact, in order, after the anchor.
      const texts = result.messages.flatMap((m) =>
        m.parts.filter((p): p is Message.TextPart => p.type === "text").map((p) => p.text),
      );
      expect(texts[0]).toContain("anchor-v1");
      expect(texts[1]).toBe(userText);
      expect(texts[2]).toBe("u2");
    });

    it("threads the previous anchor body through the second cut — no recursive re-summarization", async () => {
      const calls: Array<{ input: Message.WithParts[]; previous: string | undefined }> = [];
      const summarize = async (input: Message.WithParts[], previous?: string) => {
        calls.push({ input, previous });
        return previous === undefined ? "anchor-v1" : `${previous}+v2`;
      };
      const first = await Compaction.compact(
        [
          makeUserMessage("u0"),
          makeAssistantMessage("a1"),
          makeAssistantMessage("a2"),
          makeUserMessage("u3"),
          makeAssistantMessage("a4"),
        ],
        { ...opts, onSummarize: summarize },
        trace,
        Bus,
        { trigger: "threshold" },
      );
      expect(calls[0]?.previous).toBeUndefined();

      // Grow the compacted history and cut again: the anchor render from cut
      // one sits in the new cut span.
      const grown = [
        ...first.messages,
        makeAssistantMessage("a5"),
        makeAssistantMessage("a6"),
        makeUserMessage("u7"),
        makeAssistantMessage("a8"),
      ];
      const second = await Compaction.compact(
        grown,
        { ...opts, onSummarize: summarize },
        trace,
        Bus,
        { trigger: "threshold" },
      );

      expect(calls).toHaveLength(2);
      // The previous anchor arrived as state, not as content:
      expect(calls[1]?.previous).toBe("anchor-v1");
      // ...and the anchor RENDER never re-entered the summarizer input.
      const secondInputTexts = calls[1]?.input.flatMap((m) =>
        m.parts.filter((p): p is Message.TextPart => p.type === "text").map((p) => p.text),
      );
      expect(secondInputTexts?.some((t) => t.includes("anchor-v1"))).toBe(false);
      expect(calls[1]?.input.every((m) => m.info.role === "assistant")).toBe(true);
      // Exactly one anchor message in the result — replaced, not stacked.
      const anchors = second.messages.filter((m) =>
        m.parts.some((p) => p.type === "text" && p.metadata?.compactionAnchor === true),
      );
      expect(anchors).toHaveLength(1);
      const anchorPart = anchors[0]?.parts[0];
      if (anchorPart?.type !== "text") throw new Error("shape");
      expect(anchorPart.metadata?.anchorBody).toBe("anchor-v1+v2");
      // #702 (L3): the anchor carries the ordered window selection — every
      // message that follows it, by id — so a product-side observer can
      // persist the whole replacement record by persisting this message.
      const kept = anchorPart.metadata?.keptMessageIds;
      if (!Array.isArray(kept)) throw new Error("expected keptMessageIds");
      expect(kept).toEqual(second.messages.slice(1).map((m) => m.info.id));
    });

    it("skips the model call when the cut span holds nothing summarizable", async () => {
      let called = 0;
      // First cut produces an anchor; the follow-up span contains only user
      // messages, so the anchor must carry forward without a summarize call.
      const first = await Compaction.compact(
        [
          makeUserMessage("u0"),
          makeAssistantMessage("a1"),
          makeUserMessage("u2"),
          makeAssistantMessage("a3"),
        ],
        {
          ...opts,
          onSummarize: async () => {
            called += 1;
            return "anchor-v1";
          },
        },
        trace,
        Bus,
        { trigger: "threshold" },
      );
      expect(called).toBe(1);
      const anchorMessage = first.messages[0];
      if (anchorMessage === undefined) throw new Error("shape");
      // Cut span = [anchor, u4, u5]: nothing summarizable, anchor must carry.
      const grown = [
        anchorMessage,
        makeUserMessage("u4"),
        makeUserMessage("u5"),
        makeUserMessage("u6"),
        makeAssistantMessage("tail"),
      ];
      const second = await Compaction.compact(
        grown,
        {
          ...opts,
          protectRecentMessages: 2,
          onSummarize: async () => {
            called += 1;
            return "should-not-run";
          },
        },
        trace,
        Bus,
        { trigger: "threshold" },
      );
      expect(called).toBe(1);
      const anchorPart = second.messages[0]?.parts[0];
      if (anchorPart?.type !== "text") throw new Error("shape");
      expect(anchorPart.metadata?.anchorBody).toBe("anchor-v1");
    });

    it("keeps the newest user message even when it alone exceeds the budget", async () => {
      const huge = "h".repeat(500);
      // protect 2 → the cut span is [old-user, a1, huge, a2]; both user
      // messages face the budget, only the newest survives it.
      const result = await Compaction.compact(
        [
          makeUserMessage("old-user"),
          makeAssistantMessage("a1"),
          makeUserMessage(huge),
          makeAssistantMessage("a2"),
          makeUserMessage("tail-u"),
          makeAssistantMessage("tail-a"),
        ],
        {
          ...opts,
          preserveUserMessageChars: 100,
          onSummarize: async () => "anchor",
        },
        trace,
        Bus,
        { trigger: "threshold" },
      );
      const texts = result.messages.flatMap((m) =>
        m.parts.filter((p): p is Message.TextPart => p.type === "text").map((p) => p.text),
      );
      // Budget 100 < 500: newest kept anyway; the older user no longer fits.
      expect(texts).toContain(huge);
      expect(texts).not.toContain("old-user");
    });

    it("refuses a zero-progress cut instead of reporting it as compaction (review M1)", async () => {
      let called = 0;
      // All-user span within budget: the rebuild would be [same users, tail]
      // — not one char smaller. Committing it would count as progress toward
      // the #651 disarm while reclaiming nothing, so it must be a recorded
      // non-action, and the summarizer must not be paid for it.
      const result = await Compaction.compact(
        [
          makeUserMessage("u0"),
          makeUserMessage("u1"),
          makeUserMessage("u2"),
          makeUserMessage("u3"),
          makeUserMessage("tail-1"),
          makeAssistantMessage("tail-2"),
        ],
        {
          ...opts,
          onSummarize: async () => {
            called += 1;
            return "never";
          },
        },
        trace,
        Bus,
        { trigger: "threshold" },
      );
      expect(called).toBe(0);
      expect(result.compacted).toBe(false);
      expect(result.removedCount).toBe(0);
      expect(result.messages).toHaveLength(6);
    });

    it("records anchored=false when a cut commits without an anchor render", async () => {
      const completed: Array<{ outcome: string; anchored?: boolean }> = [];
      const unsubscribe = Bus.subscribe(AgentExecution.CompactionCompleted, (event) => {
        completed.push(event as unknown as { outcome: string; anchored?: boolean });
      });
      try {
        // Whitespace merge + no prior anchor: the assistant span is dropped
        // with only preserved users heading the window — a different loss
        // class than an anchored cut, and the record must say so.
        const result = await Compaction.compact(
          [
            makeUserMessage("u0"),
            makeAssistantMessage("a1"),
            makeAssistantMessage("a2"),
            makeUserMessage("tail-u"),
            makeAssistantMessage("tail-a"),
          ],
          { ...opts, onSummarize: async () => "   " },
          trace,
          Bus,
          { trigger: "threshold" },
        );
        await Bun.sleep(0);
        expect(result.compacted).toBe(true);
        const cut = completed.find((event) => event.outcome === "cut");
        expect(cut?.anchored).toBe(false);
      } finally {
        unsubscribe();
      }
    });

    it("records anchored=true when the anchor render heads the kept window", async () => {
      const completed: Array<{ outcome: string; anchored?: boolean }> = [];
      const unsubscribe = Bus.subscribe(AgentExecution.CompactionCompleted, (event) => {
        completed.push(event as unknown as { outcome: string; anchored?: boolean });
      });
      try {
        await Compaction.compact(
          [
            makeUserMessage("u0"),
            makeAssistantMessage("a1"),
            makeAssistantMessage("a2"),
            makeUserMessage("tail-u"),
            makeAssistantMessage("tail-a"),
          ],
          { ...opts, onSummarize: async () => "anchor body" },
          trace,
          Bus,
          { trigger: "threshold" },
        );
        await Bun.sleep(0);
        const cut = completed.find((event) => event.outcome === "cut");
        expect(cut?.anchored).toBe(true);
      } finally {
        unsubscribe();
      }
    });
  });
});
