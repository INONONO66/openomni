import { describe, expect, it, jest } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Compaction, CompactionSession } from "../../src/compaction";
import { collector } from "../helpers/observation-collector";
import { messageSequence } from "../helpers/messages";

const sequence = messageSequence("spec-session", ` ${"filler ".repeat(40)}`);
function message(role: "user" | "assistant", text: string): Message.WithParts {
  return sequence[role](text);
}
function history(): Message.WithParts[] {
  return [
    message("user", "goal"),
    message("assistant", "work-1"),
    message("assistant", "work-2"),
    message("user", "tail"),
    message("assistant", "answer"),
  ];
}
const identity = { traceId: "trace", sessionId: "spec-session", runId: "run" };

interface CallCounter {
  count: number;
}

/** A speculation session whose summarizer counts its calls and answers `summary(call)`. */
function countingSession(summary: (call: number) => string): {
  session: CompactionSession;
  calls: CallCounter;
} {
  const calls: CallCounter = { count: 0 };
  const session = new CompactionSession({
    protectRecentMessages: 2,
    summarize: async () => {
      calls.count += 1;
      return summary(calls.count);
    },
  });
  return { session, calls };
}

/** Threshold-triggered compaction offered the session's warm candidate; the sync summarizer counts into `calls`. */
function compactWith(
  session: CompactionSession,
  messages: Message.WithParts[],
  calls?: CallCounter,
) {
  return Compaction.compact(
    messages,
    {
      contextWindowTokens: 1000,
      protectRecentMessages: 2,
      onSummarize: async () => {
        if (calls) calls.count += 1;
        return "sync";
      },
    },
    identity,
    collector(),
    { trigger: "threshold", measuredTokens: 800, candidate: session.candidate() },
  );
}

describe("run-scoped compaction speculation", () => {
  it("starts only at the prepare boundary", async () => {
    const { session, calls } = countingSession(() => "anchor");
    session.prepare(history(), 59, 60, 1000);
    await session.settled();
    expect(calls.count).toBe(0);
    session.prepare(history(), 60, 60, 1000);
    await session.settled();
    expect(calls.count).toBe(1);
  });

  it("is single-flight and retains one candidate", async () => {
    let calls = 0;
    const releases: Array<(summary: string) => void> = [];
    const session = new CompactionSession({
      protectRecentMessages: 2,
      summarize: () =>
        new Promise((resolve) => {
          calls += 1;
          releases.push(resolve);
        }),
    });
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
    const messages = history();
    const { session, calls } = countingSession(() => "prepared");
    session.prepare(messages, 70, 60, 1000);
    await session.settled();
    const result = await compactWith(session, messages, calls);
    expect(result.candidate).toBe("promoted");
    expect(calls.count).toBe(1);
  });

  it("discards a changed prefix and falls back synchronously", async () => {
    const messages = history();
    const { session, calls } = countingSession(() => "prepared");
    session.prepare(messages, 70, 60, 1000);
    await session.settled();
    const changed = structuredClone(messages);
    const part = changed[1]?.parts[0];
    if (part?.type !== "text") throw new Error("expected text fixture");
    part.text = "changed";
    const result = await compactWith(session, changed, calls);
    expect(result.candidate).toBe("discarded");
    expect(calls.count).toBe(2);
  });

  it("promotes across appended turns and preserves the appended tail", async () => {
    const messages = history();
    const { session, calls } = countingSession(() => "prefix-anchor");
    session.prepare(messages, 70, 60, 1000);
    await session.settled();
    const grown = [...messages, message("user", "late-q"), message("assistant", "late-a")];
    const result = await compactWith(session, grown, calls);
    expect(result.candidate).toBe("promoted");
    expect(calls.count).toBe(1);
    expect(
      result.messages
        .flatMap((entry) => entry.parts)
        .some((part) => part.type === "text" && part.text.includes("late-q")),
    ).toBe(true);
  });

  it("keeps a candidate valid when only a completed tool output changes", async () => {
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
    const { session, calls } = countingSession(() => "tool-anchor");
    session.prepare(messages, 70, 60, 1000);
    await session.settled();
    const changed = structuredClone(messages);
    const tool = changed[1]?.parts.find((part) => part.type === "tool");
    if (tool?.type !== "tool" || tool.state.status !== "completed") {
      throw new Error("expected completed tool fixture");
    }
    tool.state.output = "[output elided by compaction]";
    const result = await compactWith(session, changed, calls);
    expect(result.candidate).toBe("promoted");
    expect(calls.count).toBe(1);
  });

  it("invalidates a warm candidate when a different compaction anchor lands", async () => {
    const { session, calls } = countingSession((call) => `anchor-${call}`);
    session.prepare(history(), 70, 60, 1000);
    await session.settled();
    const landed = message("user", "landed-compaction");
    const part = landed.parts[0];
    if (part?.type !== "text") throw new Error("expected text fixture");
    landed.parts = [{ ...part, metadata: { compactionAnchor: true, anchorBody: "other" } }];
    session.prepare([landed, ...history()], 70, 60, 1000);
    await session.settled();
    expect(calls.count).toBe(2);
  });

  it("replaces a stale candidate during the next background prepare", async () => {
    const { session, calls } = countingSession((call) => `anchor-${call}`);
    session.prepare(history(), 70, 60, 1000);
    await session.settled();
    const replacement = history();
    session.prepare(replacement, 70, 60, 1000);
    await session.settled();
    const result = await compactWith(session, replacement);
    expect(calls.count).toBe(2);
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
    const tiny = [
      message("user", "q"),
      message("assistant", "a"),
      message("user", "t1"),
      message("user", "t2"),
    ];
    const { session, calls } = countingSession(() => "x".repeat(5000));
    session.prepare(tiny, 70, 60, 1000);
    await session.settled();
    const grown = [
      ...tiny,
      ...Array.from({ length: 8 }, (_entry, index) => message("assistant", `late-${index}`)),
      message("user", "tail-q"),
      message("assistant", "tail-a"),
    ];
    const result = await compactWith(session, grown, calls);
    expect(result).toMatchObject({ candidate: "discarded", compacted: true });
    expect(calls.count).toBe(2);
  });

  it("retains an unevaluated candidate after a protected-tail no-op", async () => {
    const messages = history();
    const { session, calls } = countingSession(() => "kept-candidate");
    session.prepare(messages, 70, 60, 1000);
    await session.settled();
    const short = await compactWith(session, messages.slice(0, 2));
    expect(short.candidate).toBeUndefined();
    const result = await compactWith(session, messages);
    expect(result.candidate).toBe("promoted");
    expect(calls.count).toBe(1);
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
    const { session, calls } = countingSession(() => "late");
    session.prepare(history(), 70, 60, 1000);
    session.abort();
    await session.settled();
    expect(calls.count).toBe(0);
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
    const session = new CompactionSession({
      protectRecentMessages: 2,
      summarize: async () => {
        calls += 1;
        throw new Error("provider down");
      },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      session.prepare(history(), 70, 60, 1000);
      await session.settled();
    }
    expect(calls).toBe(2);
  });
});
