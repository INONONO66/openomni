import { describe, expect, it, jest } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Compaction, CompactionSession } from "../../src/compaction";
import { collector } from "../../src/observation/bus";

let sequence = 0;
function message(role: "user" | "assistant", text: string): Message.WithParts {
  sequence += 1;
  const id = `spec-${sequence}`;
  if (role === "user") {
    return {
      info: { id, sessionID: "spec-session", role, time: { created: 1 }, agent: "test", model: { providerID: "", modelID: "" } },
      parts: [{ id: `${id}-text`, sessionID: "spec-session", messageID: id, type: "text", text }],
    };
  }
  return {
    info: { id, sessionID: "spec-session", role, time: { created: 1 }, parentID: "", modelID: "m", providerID: "p", agent: "test", path: { cwd: "/", root: "/" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [{ id: `${id}-text`, sessionID: "spec-session", messageID: id, type: "text", text: `${text} ${"filler ".repeat(40)}` }],
  };
}
function history(): Message.WithParts[] {
  return [message("user", "goal"), message("assistant", "work-1"), message("assistant", "work-2"), message("user", "tail"), message("assistant", "answer")];
}
const identity = { traceId: "trace", sessionId: "spec-session", runId: "run" };

describe("run-scoped compaction speculation", () => {
  it("starts only at the prepare boundary", async () => {
    let calls = 0;
    const session = new CompactionSession({ protectRecentMessages: 2, summarize: async () => { calls += 1; return "anchor"; } });
    session.prepare(history(), 59, 60, 1000);
    await session.settled();
    expect(calls).toBe(0);
    session.prepare(history(), 60, 60, 1000);
    await session.settled();
    expect(calls).toBe(1);
  });

  it("is single-flight and retains one candidate", async () => {
    let calls = 0;
    const releases: Array<(summary: string) => void> = [];
    const session = new CompactionSession({ protectRecentMessages: 2, summarize: () => new Promise((resolve) => { calls += 1; releases.push(resolve); }) });
    const messages = history();
    session.prepare(messages, 70, 60, 1000);
    await session.started();
    session.prepare(messages, 80, 60, 1000);
    await Promise.resolve();
    for (const release of releases) release("candidate");
    await session.settled();
    session.prepare(messages, 90, 60, 1000);
    await session.settled();
    expect(calls).toBe(1);
  });

  it("promotes a fresh candidate without another summary call", async () => {
    let calls = 0;
    const messages = history();
    const session = new CompactionSession({ protectRecentMessages: 2, summarize: async () => { calls += 1; return "prepared"; } });
    session.prepare(messages, 70, 60, 1000);
    await session.settled();
    const result = await Compaction.compact(messages, { contextWindowTokens: 1000, protectRecentMessages: 2, onSummarize: async () => { calls += 1; return "sync"; } }, identity, collector(), { trigger: "threshold", measuredTokens: 800, candidate: session.candidate() });
    expect(result.candidate).toBe("promoted");
    expect(calls).toBe(1);
  });

  it("discards a changed prefix and falls back synchronously", async () => {
    let calls = 0;
    const messages = history();
    const session = new CompactionSession({ protectRecentMessages: 2, summarize: async () => { calls += 1; return "prepared"; } });
    session.prepare(messages, 70, 60, 1000);
    await session.settled();
    const changed = structuredClone(messages);
    const part = changed[1]?.parts[0];
    if (part?.type !== "text") throw new Error("expected text fixture");
    part.text = "changed";
    const result = await Compaction.compact(changed, { contextWindowTokens: 1000, protectRecentMessages: 2, onSummarize: async () => { calls += 1; return "sync"; } }, identity, collector(), { trigger: "threshold", measuredTokens: 800, candidate: session.candidate() });
    expect(result.candidate).toBe("discarded");
    expect(calls).toBe(2);
  });

  it("promotes across appended turns and preserves the appended tail", async () => {
    let calls = 0;
    const messages = history();
    const session = new CompactionSession({
      protectRecentMessages: 2,
      summarize: async () => {
        calls += 1;
        return "prefix-anchor";
      },
    });
    session.prepare(messages, 70, 60, 1000);
    await session.settled();
    const grown = [...messages, message("user", "late-q"), message("assistant", "late-a")];
    const result = await Compaction.compact(
      grown,
      {
        contextWindowTokens: 1000,
        protectRecentMessages: 2,
        onSummarize: async () => {
          calls += 1;
          return "sync";
        },
      },
      identity,
      collector(),
      { trigger: "threshold", measuredTokens: 800, candidate: session.candidate() },
    );
    expect(result.candidate).toBe("promoted");
    expect(calls).toBe(1);
    expect(result.messages.flatMap((entry) => entry.parts).some(
      (part) => part.type === "text" && part.text.includes("late-q"),
    )).toBe(true);
  });

  it("keeps a candidate valid when only a completed tool output changes", async () => {
    let calls = 0;
    const messages = history();
    const owner = messages[1];
    if (owner === undefined) throw new Error("expected assistant fixture");
    owner.parts.push({
      id: "tool-part",
      sessionID: "spec-session",
      messageID: owner.info.id,
      type: "tool",
      callID: "call-1",
      tool: "read",
      state: {
        status: "completed",
        input: { path: "/tmp/a" },
        output: "large original output",
        title: "read",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    });
    const session = new CompactionSession({
      protectRecentMessages: 2,
      summarize: async () => {
        calls += 1;
        return "tool-anchor";
      },
    });
    session.prepare(messages, 70, 60, 1000);
    await session.settled();
    const changed = structuredClone(messages);
    const tool = changed[1]?.parts.find((part) => part.type === "tool");
    if (tool?.type !== "tool" || tool.state.status !== "completed") {
      throw new Error("expected completed tool fixture");
    }
    tool.state.output = "[output elided by compaction]";
    const result = await Compaction.compact(
      changed,
      {
        contextWindowTokens: 1000,
        protectRecentMessages: 2,
        onSummarize: async () => {
          calls += 1;
          return "sync";
        },
      },
      identity,
      collector(),
      { trigger: "threshold", measuredTokens: 800, candidate: session.candidate() },
    );
    expect(result.candidate).toBe("promoted");
    expect(calls).toBe(1);
  });

  it("invalidates a warm candidate when a different compaction anchor lands", async () => {
    let calls = 0;
    const session = new CompactionSession({
      protectRecentMessages: 2,
      summarize: async () => {
        calls += 1;
        return `anchor-${calls}`;
      },
    });
    session.prepare(history(), 70, 60, 1000);
    await session.settled();
    const landed = message("user", "landed-compaction");
    const part = landed.parts[0];
    if (part?.type !== "text") throw new Error("expected text fixture");
    landed.parts = [{ ...part, metadata: { compactionAnchor: true, anchorBody: "other" } }];
    session.prepare([landed, ...history()], 70, 60, 1000);
    await session.settled();
    expect(calls).toBe(2);
  });

  it("replaces a stale candidate during the next background prepare", async () => {
    let calls = 0;
    const session = new CompactionSession({
      protectRecentMessages: 2,
      summarize: async () => {
        calls += 1;
        return `anchor-${calls}`;
      },
    });
    session.prepare(history(), 70, 60, 1000);
    await session.settled();
    const replacement = history();
    session.prepare(replacement, 70, 60, 1000);
    await session.settled();
    const result = await Compaction.compact(
      replacement,
      { contextWindowTokens: 1000, protectRecentMessages: 2, onSummarize: async () => "sync" },
      identity,
      collector(),
      { trigger: "threshold", measuredTokens: 800, candidate: session.candidate() },
    );
    expect(calls).toBe(2);
    expect(result.candidate).toBe("promoted");
  });

  it("recovers from a background prepare failure through the synchronous seam", async () => {
    let calls = 0;
    const messages = history();
    const session = new CompactionSession({
      protectRecentMessages: 2,
      summarize: async () => {
        calls += 1;
        if (calls === 1) throw new Error("provider down");
        return "recovered";
      },
    });
    session.prepare(messages, 70, 60, 1000);
    await session.settled();
    expect(session.candidate()).toBeUndefined();
    const result = await Compaction.compact(
      messages,
      {
        contextWindowTokens: 1000,
        protectRecentMessages: 2,
        onSummarize: async () => {
          calls += 1;
          return "recovered";
        },
      },
      identity,
      collector(),
      { trigger: "threshold", measuredTokens: 800, candidate: session.candidate() },
    );
    expect(result.compacted).toBe(true);
    expect(calls).toBe(2);
  });

  it("falls back synchronously when a valid candidate cannot reclaim", async () => {
    let calls = 0;
    const tiny = [
      message("user", "q"),
      message("assistant", "a"),
      message("user", "t1"),
      message("user", "t2"),
    ];
    const session = new CompactionSession({
      protectRecentMessages: 2,
      summarize: async () => {
        calls += 1;
        return "x".repeat(5000);
      },
    });
    session.prepare(tiny, 70, 60, 1000);
    await session.settled();
    const grown = [
      ...tiny,
      ...Array.from({ length: 8 }, (_entry, index) => message("assistant", `late-${index}`)),
      message("user", "tail-q"),
      message("assistant", "tail-a"),
    ];
    const result = await Compaction.compact(
      grown,
      {
        contextWindowTokens: 1000,
        protectRecentMessages: 2,
        onSummarize: async () => {
          calls += 1;
          return "sync-anchor";
        },
      },
      identity,
      collector(),
      { trigger: "threshold", measuredTokens: 800, candidate: session.candidate() },
    );
    expect(result).toMatchObject({ candidate: "discarded", compacted: true });
    expect(calls).toBe(2);
  });

  it("retains an unevaluated candidate after a protected-tail no-op", async () => {
    let calls = 0;
    const messages = history();
    const session = new CompactionSession({
      protectRecentMessages: 2,
      summarize: async () => {
        calls += 1;
        return "kept-candidate";
      },
    });
    session.prepare(messages, 70, 60, 1000);
    await session.settled();
    const short = await Compaction.compact(
      messages.slice(0, 2),
      { contextWindowTokens: 1000, protectRecentMessages: 2, onSummarize: async () => "sync" },
      identity,
      collector(),
      { trigger: "threshold", measuredTokens: 800, candidate: session.candidate() },
    );
    expect(short.candidate).toBeUndefined();
    const result = await Compaction.compact(
      messages,
      { contextWindowTokens: 1000, protectRecentMessages: 2, onSummarize: async () => "sync" },
      identity,
      collector(),
      { trigger: "threshold", measuredTokens: 800, candidate: session.candidate() },
    );
    expect(result.candidate).toBe("promoted");
    expect(calls).toBe(1);
  });

  it("uses deterministic fallback when the summarizer deadline expires", async () => {
    jest.useFakeTimers();
    try {
      const entered = Promise.withResolvers<void>();
      const pending = Compaction.compact(
        history(),
        {
          contextWindowTokens: 1000,
          protectRecentMessages: 2,
          summarizerDeadlineMs: 100,
          onSummarize: (_messages, _previous, _budget, signal) => {
            entered.resolve();
            return new Promise<string>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        },
        identity,
        collector(),
        { trigger: "threshold", measuredTokens: 800 },
      );
      await entered.promise;
      jest.advanceTimersByTime(100);
      await expect(pending).resolves.toMatchObject({ compacted: true, summarizerFailed: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it("aborts before the scheduled summary starts", async () => {
    let calls = 0;
    const session = new CompactionSession({ protectRecentMessages: 2, summarize: async () => { calls += 1; return "late"; } });
    session.prepare(history(), 70, 60, 1000);
    session.abort();
    await session.settled();
    expect(calls).toBe(0);
    expect(session.candidate()).toBeUndefined();
  });

  it("aborts an active summary through its exact signal", async () => {
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const session = new CompactionSession({
      protectRecentMessages: 2,
      summarize: (_messages, _previous, _budget, signal) =>
        new Promise<string>((_resolve, reject) => {
          entered();
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    session.prepare(history(), 70, 60, 1000);
    await started;
    session.abort();
    await session.settled();
    expect(session.candidate()).toBeUndefined();
  });

  it("stops preparing after two failures", async () => {
    let calls = 0;
    const session = new CompactionSession({ protectRecentMessages: 2, summarize: async () => { calls += 1; throw new Error("provider down"); } });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      session.prepare(history(), 70, 60, 1000);
      await session.settled();
    }
    expect(calls).toBe(2);
  });
});
