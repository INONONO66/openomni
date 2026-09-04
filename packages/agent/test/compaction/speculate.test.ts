import { describe, expect, it, jest } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Bus, collector } from "../../src/index";
import { createCompactionPolicy } from "../../src/compaction/policy";
import { createSpeculator } from "../../src/compaction/speculate";

/**
 * L4 (#714): speculative prepare/promote. The expensive summarize runs in
 * the background at turn settlement; the seam promotes a fresh candidate
 * with zero model calls; a stale candidate is discarded visibly and the
 * synchronous merge runs. Application never leaves run.completion.pre.
 */

let idCounter = 0;
const sessionID = "spec-test";

function user(text: string): Message.WithParts {
  idCounter += 1;
  const id = `spec-user-${idCounter}`;
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "t",
      model: { providerID: "", modelID: "" },
    },
    parts: [{ id: `${id}-t`, sessionID, messageID: id, type: "text", text }],
  };
}

function assistant(text: string): Message.WithParts {
  idCounter += 1;
  const id = `spec-assistant-${idCounter}`;
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: 1 },
      parentID: "",
      modelID: "m",
      providerID: "p",
      agent: "t",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: `${id}-t`,
        sessionID,
        messageID: id,
        type: "text",
        text: `${text}\n${"filler ".repeat(50)}`,
      },
    ],
  };
}

function history(): Message.WithParts[] {
  return [user("goal"), assistant("a1"), assistant("a2"), user("tail-q"), assistant("tail-a")];
}

function turnPostCtx(messages: Message.WithParts[], contextTokens: number) {
  return {
    pointId: "run.turn.post",
    timing: "turn.finish",
    traceContext: { traceId: "trace-spec", sessionId: sessionID },
    sessionId: sessionID,
    runId: "run-spec",
    messages,
    contextTokens,
    contextWindowTokens: 32_000,
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 1,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
  } as never;
}

function seamCtx(messages: Message.WithParts[], contextTokens: number) {
  return {
    pointId: "run.completion.pre",
    timing: "turn.finish",
    traceContext: { traceId: "trace-spec", sessionId: sessionID },
    sessionId: sessionID,
    runId: "run-spec",
    messages,
    contextTokens,
    contextWindowTokens: 32_000,
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 1,
    isCompletion: true,
    continuationCount: 0,
    elapsedMs: 0,
  } as never;
}

function build(
  summarize: (
    m: Message.WithParts[],
    p: string | undefined,
    _budget: { maxInputTokens: number },
    signal?: AbortSignal,
  ) => Promise<string>,
) {
  return createCompactionPolicy({
    contextWindowTokens: 32_000,
    protectRecentMessages: 2,
    onSummarize: summarize,
    events: Bus,
    priority: 900,
  }).create();
}

async function settle(registration: unknown): Promise<void> {
  await (
    registration as { readonly speculationSettled?: () => Promise<void> }
  ).speculationSettled?.();
}

describe("speculative prepare/promote (L4)", () => {
  it("registers turn.post only when speculation is live", () => {
    const withSpec = build(async () => "x");
    expect(withSpec.pointIds).toEqual(["run.turn.post", "run.completion.pre"]);
    expect(withSpec.effectCapabilities["run.turn.post"]).toEqual([]);

    const noSummarizer = createCompactionPolicy({
      contextWindowTokens: 32_000,
      events: Bus,
      priority: 900,
    }).create();
    expect(noSummarizer.pointIds).toEqual(["run.completion.pre"]);

    const disabled = createCompactionPolicy({
      contextWindowTokens: 32_000,
      onSummarize: async () => "x",
      speculate: false,
      events: Bus,
      priority: 900,
    }).create();
    expect(disabled.pointIds).toEqual(["run.completion.pre"]);
  });

  it("prepares in the background at the prepare ratio, not below it", async () => {
    let calls = 0;
    const registration = build(async () => {
      calls += 1;
      return "candidate";
    });
    await registration.fn(turnPostCtx(history(), 7_000)); // below the adaptive prepare point
    await settle(registration);
    expect(calls).toBe(0);

    await registration.fn(turnPostCtx(history(), 8_000)); // above the adaptive prepare point
    await settle(registration);
    expect(calls).toBe(1);
  });

  it("defers only below the exact grace boundary", async () => {
    const evaluate = async (tokens: number): Promise<{ calls: number; deferred: boolean }> => {
      let calls = 0;
      let release: (value: string) => void = () => undefined;
      const registration = build(
        () =>
          new Promise<string>((resolve) => {
            calls += 1;
            if (calls === 1) release = resolve;
            else resolve("synchronous");
          }),
      );
      const messages = history();
      await registration.fn(turnPostCtx(messages, 8_000));
      await (registration as { speculationStarted?: () => Promise<void> }).speculationStarted?.();
      const decision = await registration.fn(seamCtx(messages, tokens));
      release("candidate");
      await settle(registration);
      return {
        calls,
        deferred: decision.reasonCodes.includes("compaction_deferred_speculation_grace"),
      };
    };

    expect(await evaluate(24_191)).toEqual({ calls: 1, deferred: true });
    expect(await evaluate(24_192)).toEqual({ calls: 2, deferred: false });
    expect(await evaluate(24_193)).toEqual({ calls: 2, deferred: false });
  });

  it("is single-flight and keeps one candidate", async () => {
    let calls = 0;
    let release: (value: string) => void = () => undefined;
    const registration = build(
      () =>
        new Promise<string>((resolve) => {
          calls += 1;
          release = resolve;
        }),
    );
    const messages = history();
    await registration.fn(turnPostCtx(messages, 8_000));
    await registration.fn(turnPostCtx(messages, 9_000)); // while in flight
    release("candidate");
    await settle(registration);
    await registration.fn(turnPostCtx(messages, 10_000)); // candidate already held
    await settle(registration);
    expect(calls).toBe(1);
  });

  it("promotes a fresh candidate at the seam with zero further model calls", async () => {
    let calls = 0;
    const registration = build(async () => {
      calls += 1;
      return "prepared-anchor";
    });
    const messages = history();
    await registration.fn(turnPostCtx(messages, 8_000));
    await settle(registration);
    expect(calls).toBe(1);

    const decision = await registration.fn(seamCtx(messages, 17_000));
    expect(calls).toBe(1); // promoted — no synchronous merge
    expect((decision as { reasonCodes?: string[] }).reasonCodes).toContain(
      "compaction_candidate_promoted",
    );
    const effect = (
      decision as { effects: Array<{ type: string; messages?: unknown }> }
    ).effects.find((entry) => entry.type === "run.replace_messages");
    const rebuilt = effect?.messages as Array<{ parts: Array<{ text?: string }> }>;
    expect(rebuilt[0]?.parts[0]?.text).toContain("prepared-anchor");
  });

  it("promotes across appended turns: the candidate span is a live prefix", async () => {
    let calls = 0;
    const registration = build(async () => {
      calls += 1;
      return "prefix-anchor";
    });
    const messages = history();
    await registration.fn(turnPostCtx(messages, 8_000));
    await settle(registration);

    // Two more turns landed before the seam fired.
    const grown = [...messages, user("late-q"), assistant("late-a")];
    const decision = await registration.fn(seamCtx(grown, 18_000));
    expect(calls).toBe(1);
    expect((decision as { reasonCodes?: string[] }).reasonCodes).toContain(
      "compaction_candidate_promoted",
    );
    // The candidate cut only its own span: the late turns survive in the window.
    const effect = (
      decision as { effects: Array<{ type: string; messages?: unknown }> }
    ).effects.find((entry) => entry.type === "run.replace_messages");
    const texts = (effect?.messages as Array<{ parts: Array<{ text?: string }> }>).flatMap((m) =>
      m.parts.map((p) => p.text ?? ""),
    );
    expect(texts.some((t) => t.includes("late-q"))).toBe(true);
  });

  it("rejects the same prefix ids when assistant text changed", async () => {
    let calls = 0;
    const registration = build(async () => {
      calls += 1;
      return `anchor-${calls}`;
    });
    const messages = history();
    await registration.fn(turnPostCtx(messages, 8_000));
    await settle(registration);
    const changed = structuredClone(messages);
    const part = changed[1]?.parts[0];
    if (part?.type !== "text") throw new Error("shape");
    part.text = "adversarial replacement";

    const decision = await registration.fn(seamCtx(changed, 17_000));
    expect(calls).toBe(2);
    expect(decision.reasonCodes).toContain("compaction_candidate_discarded");
  });

  it("promotes when only a completed tool output was elided", async () => {
    let calls = 0;
    const registration = build(async () => {
      calls += 1;
      return "tool-anchor";
    });
    const messages = history();
    const assistantMessage = messages[1];
    if (assistantMessage === undefined) throw new Error("shape");
    assistantMessage.parts.push({
      id: "tool-part",
      sessionID,
      messageID: assistantMessage.info.id,
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
    await registration.fn(turnPostCtx(messages, 8_000));
    await settle(registration);
    const elided = structuredClone(messages);
    const tool = elided[1]?.parts.find((part) => part.type === "tool");
    if (tool?.type !== "tool" || tool.state.status !== "completed") throw new Error("shape");
    tool.state.output = "[output elided by compaction]";

    const decision = await registration.fn(seamCtx(elided, 17_000));
    expect(calls).toBe(1);
    expect(decision.reasonCodes).toContain("compaction_candidate_promoted");
  });

  it("invalidates a warm candidate when another compaction anchor lands", async () => {
    let calls = 0;
    const registration = build(async () => {
      calls += 1;
      return `anchor-${calls}`;
    });
    const original = history();
    await registration.fn(turnPostCtx(original, 8_000));
    await settle(registration);
    const landed = user("landed-compaction");
    const part = landed.parts[0];
    if (part?.type !== "text") throw new Error("shape");
    landed.parts = [{ ...part, metadata: { compactionAnchor: true, anchorBody: "other" } }];
    await registration.fn(turnPostCtx([landed, ...history()], 8_000));
    await settle(registration);
    expect(calls).toBe(2);
  });

  it("replaces a stale candidate during the next background prepare", async () => {
    let calls = 0;
    const registration = build(async () => {
      calls += 1;
      return `anchor-${calls}`;
    });
    const original = history();
    await registration.fn(turnPostCtx(original, 8_000));
    await settle(registration);

    const replaced = history();
    await registration.fn(turnPostCtx(replaced, 8_000));
    await settle(registration);
    expect(calls).toBe(2);

    const decision = await registration.fn(seamCtx(replaced, 17_000));
    expect((decision as { reasonCodes?: string[] }).reasonCodes).toContain(
      "compaction_candidate_promoted",
    );
  });

  it("discards a stale candidate visibly and falls back to the synchronous merge", async () => {
    let calls = 0;
    const registration = build(async () => {
      calls += 1;
      return `anchor-${calls}`;
    });
    const messages = history();
    await registration.fn(turnPostCtx(messages, 8_000));
    await settle(registration);
    expect(calls).toBe(1);

    // History replaced (fresh ids): the candidate's span is no longer a prefix.
    const replaced = history();
    const decision = await registration.fn(seamCtx(replaced, 17_000));
    expect(calls).toBe(2); // synchronous merge ran
    expect((decision as { reasonCodes?: string[] }).reasonCodes).toContain(
      "compaction_candidate_discarded",
    );
  });

  it("warns once and uses snap-cut after a synchronous summarizer failure", async () => {
    const events = collector();
    let calls = 0;
    const registration = createCompactionPolicy({
      contextWindowTokens: 32_000,
      protectRecentMessages: 2,
      speculate: false,
      onSummarize: async () => {
        calls += 1;
        throw new Error("summarizer down");
      },
      events,
      priority: 900,
    }).create();
    const messages = history();
    const first = await registration.fn(seamCtx(messages, 17_000));
    const second = await registration.fn(seamCtx(messages, 17_000));
    expect(calls).toBe(1);
    expect((first as { reasonCodes?: string[] }).reasonCodes).toContain(
      "compaction_summarizer_failed",
    );
    expect((second as { reasonCodes?: string[] }).reasonCodes).not.toContain(
      "compaction_summarizer_failed",
    );
    const warnings = events.named("operational.warn") as Array<{
      context?: Record<string, unknown>;
    }>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.context).toEqual({ reasonCode: "compaction_summarizer_failed" });
  });

  it("disables speculative and synchronous calls after synchronous fallback", async () => {
    let calls = 0;
    const registration = build(async () => {
      calls += 1;
      throw new Error("summarizer down");
    });
    const messages = history();
    const first = await registration.fn(seamCtx(messages, 17_000));
    expect(first.reasonCodes).toContain("compaction_summarizer_failed");
    expect(calls).toBe(1);

    await registration.fn(turnPostCtx(messages, 18_000));
    await settle(registration);
    const second = await registration.fn(seamCtx(messages, 18_000));
    expect(second.reasonCodes).not.toContain("compaction_summarizer_failed");
    expect(calls).toBe(1);
  });

  it("uses one warned fallback when the summarizer deadline expires", async () => {
    jest.useFakeTimers();
    try {
      const events = collector();
      let calls = 0;
      let started: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const factory = createCompactionPolicy({
        contextWindowTokens: 32_000,
        protectRecentMessages: 2,
        speculate: false,
        summarizerDeadlineMs: 100,
        onSummarize: (_messages, _previous, _budget, signal) => {
          calls += 1;
          started();
          return new Promise<string>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        events,
        priority: 900,
      });
      const registration = factory.create();
      const pending = registration.fn(seamCtx(history(), 17_000));
      await entered;
      jest.advanceTimersByTime(100);
      const decision = await pending;
      expect(decision.reasonCodes).toContain("compaction_summarizer_failed");
      expect(calls).toBe(1);
      expect(events.named("operational.warn")).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("propagates external abort instead of using fallback", async () => {
    const events = collector();
    const controller = new AbortController();
    let started: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const factory = createCompactionPolicy({
      contextWindowTokens: 32_000,
      protectRecentMessages: 2,
      speculate: false,
      signal: controller.signal,
      onSummarize: (_messages, _previous, _budget, signal) => {
        started();
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      events,
      priority: 900,
    });
    const registration = factory.create();
    const pending = registration.fn(seamCtx(history(), 17_000));
    await entered;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(events.named("operational.warn")).toHaveLength(0);
  });

  it("a prepare failure leaves no candidate and never throws into the run", async () => {
    let calls = 0;
    const registration = build(async () => {
      calls += 1;
      if (calls === 1) throw new Error("provider down");
      return "recovered";
    });
    const messages = history();
    await registration.fn(turnPostCtx(messages, 8_000));
    await settle(registration);
    expect(calls).toBe(1);

    // Seam falls back to the synchronous merge — the failure stayed out of
    // the run and the retry went through the normal fail-closed bracket.
    const decision = await registration.fn(seamCtx(messages, 17_000));
    expect(calls).toBe(2);
    expect((decision as { reasonCodes?: string[] }).reasonCodes).toContain(
      "compaction_threshold_exceeded",
    );
  });

  it("a promote refused by the progress guard falls back to the synchronous merge (review M1)", async () => {
    let calls = 0;
    const registration = build(async () => {
      calls += 1;
      // The prepared anchor is enormous relative to its tiny span — the
      // promote cannot shrink the window; the sync merge's anchor is small.
      return calls === 1 ? "x".repeat(5000) : "sync-anchor";
    });
    // Tiny history at prepare time: the candidate span is small, its anchor
    // render outweighs it.
    const tiny = [user("q"), assistant("a"), user("t1"), user("t2")];
    await registration.fn(turnPostCtx(tiny, 8_000));
    await settle(registration);
    expect(calls).toBe(1);

    // The history grew massively: the candidate's tiny-span promote cannot
    // shrink the window, but the natural-span merge can. Speculation must
    // never take that cut away.
    const grown = [
      ...tiny,
      ...Array.from({ length: 8 }, (_unused, index) => assistant(`late-${index}`)),
      user("tail-q"),
      assistant("tail-a"),
    ];
    const decision = await registration.fn(seamCtx(grown, 19_000));
    expect(calls).toBe(2); // synchronous merge ran
    const reasons = (decision as { reasonCodes?: string[] }).reasonCodes ?? [];
    expect(reasons).toContain("compaction_candidate_discarded");
    expect(reasons).toContain("compaction_threshold_exceeded");
    expect(
      (decision as { effects: Array<{ type: string }> }).effects.some(
        (entry) => entry.type === "run.replace_messages",
      ),
    ).toBe(true);
  });

  it("an unevaluated candidate survives a seam that returned before the cut (review M2)", async () => {
    let calls = 0;
    const registration = build(async () => {
      calls += 1;
      return "kept-candidate";
    });
    const messages = history();
    await registration.fn(turnPostCtx(messages, 8_000));
    await settle(registration);
    expect(calls).toBe(1);

    // A seam that never reaches the candidate branch (history within the
    // protected tail) must not destroy the candidate.
    const shortSeam = await registration.fn(seamCtx(messages.slice(0, 2), 17_000));
    expect((shortSeam as { reasonCodes?: string[] }).reasonCodes).toContain(
      "compaction_skipped_nothing_reclaimed",
    );

    // The next real seam still promotes with zero further model calls.
    const decision = await registration.fn(seamCtx(messages, 17_000));
    expect(calls).toBe(1);
    expect((decision as { reasonCodes?: string[] }).reasonCodes).toContain(
      "compaction_candidate_promoted",
    );
  });

  it("does not start preparation after an abort before its microtask", async () => {
    let calls = 0;
    const speculator = createSpeculator({
      protectRecentMessages: 2,
      onSummarize: async () => {
        calls += 1;
        return "late";
      },
    });
    speculator.maybePrepare(history(), 70, 60, 100);
    speculator.abort();
    await speculator.settled();
    expect(calls).toBe(0);
  });

  it("stops preparing after the failure streak cap, visibly", async () => {
    let calls = 0;
    const registration = build(async () => {
      calls += 1;
      throw new Error("provider down");
    });
    const messages = history();
    await registration.fn(turnPostCtx(messages, 8_000));
    await settle(registration);
    await registration.fn(turnPostCtx(messages, 9_000));
    await settle(registration);
    expect(calls).toBe(2);
    // Streak cap reached: no more prepares this run.
    await registration.fn(turnPostCtx(messages, 10_000));
    await settle(registration);
    expect(calls).toBe(2);
  });
});
