import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
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
    contextWindowTokens: 100,
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
    contextWindowTokens: 100,
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 1,
    isCompletion: true,
    continuationCount: 0,
    elapsedMs: 0,
  } as never;
}

function build(
  summarize: (m: Message.WithParts[], p?: string, signal?: AbortSignal) => Promise<string>,
) {
  return createCompactionPolicy({
    contextWindowTokens: 100,
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
      contextWindowTokens: 100,
      events: Bus,
      priority: 900,
    }).create();
    expect(noSummarizer.pointIds).toEqual(["run.completion.pre"]);

    const disabled = createCompactionPolicy({
      contextWindowTokens: 100,
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
    await registration.fn(turnPostCtx(history(), 60)); // below 0.65 × 100
    await settle(registration);
    expect(calls).toBe(0);

    await registration.fn(turnPostCtx(history(), 70)); // above
    await settle(registration);
    expect(calls).toBe(1);
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
    await registration.fn(turnPostCtx(messages, 70));
    await registration.fn(turnPostCtx(messages, 75)); // while in flight
    release("candidate");
    await settle(registration);
    await registration.fn(turnPostCtx(messages, 80)); // candidate already held
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
    await registration.fn(turnPostCtx(messages, 70));
    await settle(registration);
    expect(calls).toBe(1);

    const decision = await registration.fn(seamCtx(messages, 85));
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
    await registration.fn(turnPostCtx(messages, 70));
    await settle(registration);

    // Two more turns landed before the seam fired.
    const grown = [...messages, user("late-q"), assistant("late-a")];
    const decision = await registration.fn(seamCtx(grown, 90));
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

  it("discards a stale candidate visibly and falls back to the synchronous merge", async () => {
    let calls = 0;
    const registration = build(async () => {
      calls += 1;
      return `anchor-${calls}`;
    });
    const messages = history();
    await registration.fn(turnPostCtx(messages, 70));
    await settle(registration);
    expect(calls).toBe(1);

    // History replaced (fresh ids): the candidate's span is no longer a prefix.
    const replaced = history();
    const decision = await registration.fn(seamCtx(replaced, 85));
    expect(calls).toBe(2); // synchronous merge ran
    expect((decision as { reasonCodes?: string[] }).reasonCodes).toContain(
      "compaction_candidate_discarded",
    );
  });

  it("a prepare failure leaves no candidate and never throws into the run", async () => {
    let calls = 0;
    const registration = build(async () => {
      calls += 1;
      if (calls === 1) throw new Error("provider down");
      return "recovered";
    });
    const messages = history();
    await registration.fn(turnPostCtx(messages, 70));
    await settle(registration);
    expect(calls).toBe(1);

    // Seam falls back to the synchronous merge — the failure stayed out of
    // the run and the retry went through the normal fail-closed bracket.
    const decision = await registration.fn(seamCtx(messages, 85));
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
    await registration.fn(turnPostCtx(tiny, 70));
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
    const decision = await registration.fn(seamCtx(grown, 95));
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
    await registration.fn(turnPostCtx(messages, 70));
    await settle(registration);
    expect(calls).toBe(1);

    // A seam that never reaches the candidate branch (history within the
    // protected tail) must not destroy the candidate.
    const shortSeam = await registration.fn(seamCtx(messages.slice(0, 2), 85));
    expect((shortSeam as { reasonCodes?: string[] }).reasonCodes).toContain(
      "compaction_skipped_nothing_reclaimed",
    );

    // The next real seam still promotes with zero further model calls.
    const decision = await registration.fn(seamCtx(messages, 85));
    expect(calls).toBe(1);
    expect((decision as { reasonCodes?: string[] }).reasonCodes).toContain(
      "compaction_candidate_promoted",
    );
  });

  it("does not start preparation after an abort before its microtask", async () => {
    let calls = 0;
    const speculator = createSpeculator({
      prepareRatio: 0.65,
      protectRecentMessages: 2,
      onSummarize: async () => {
        calls += 1;
        return "late";
      },
    });
    speculator.maybePrepare(history(), 70, 100);
    speculator.abort();
    await speculator.settled();
    expect(calls).toBe(0);
  });

  it("aborts an in-flight candidate when the run ends", async () => {
    const registration = build(async () => "must-not-promote");
    const messages = history();
    await registration.fn(turnPostCtx(messages, 70));
    (registration as { readonly onRunEnd?: () => void }).onRunEnd?.();
    await settle(registration);

    expect((registration as { readonly speculationSettled?: () => Promise<void> }).speculationSettled).toBeDefined();
    const decision = await registration.fn(seamCtx(messages, 85));
    expect((decision as { reasonCodes?: string[] }).reasonCodes).not.toContain(
      "compaction_candidate_promoted",
    );
  });

  it("stops preparing after the failure streak cap, visibly", async () => {
    let calls = 0;
    const registration = build(async () => {
      calls += 1;
      throw new Error("provider down");
    });
    const messages = history();
    await registration.fn(turnPostCtx(messages, 70));
    await settle(registration);
    await registration.fn(turnPostCtx(messages, 72));
    await settle(registration);
    expect(calls).toBe(2);
    // Streak cap reached: no more prepares this run.
    await registration.fn(turnPostCtx(messages, 74));
    await settle(registration);
    expect(calls).toBe(2);
  });
});
