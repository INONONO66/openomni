import { createBudgetState } from "../../src/core/budget";
import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { createCompactionPolicy } from "../../src/compaction";
import type { PolicyFn } from "../../src/core/policy";
import { effectOf } from "../helpers/policy-decision";
import { Bus } from "@openomni/telemetry";

function baseCtx(
  overrides?: Partial<Omit<Parameters<PolicyFn>[0], "pointId">>,
): Parameters<PolicyFn>[0] {
  return {
    timing: "turn.finish",
    pointId: "run.completion.pre",
    traceContext: { traceId: "trace-builtin-test" },
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

function createTestMessage(id: string): Message.WithParts {
  return {
    info: {
      id,
      sessionID: "test-session",
      role: "user",
      time: { created: Date.now() },
      agent: "test-agent",
      model: { providerID: "test", modelID: "test" },
      system: `Test message ${id}`,
    },
    parts: [
      {
        id: `part-${id}`,
        sessionID: "test-session",
        messageID: id,
        type: "text",
        text: `Test message ${id}`,
      },
    ],
  };
}

describe("createCompactionPolicy", () => {
  /**
   * `run.completion.pre` is fail-closed: a throw here becomes a deny carrying
   * `run.abort`, which ends the run. Skipping is the lesser failure, and the
   * reason code says which one happened.
   */
  it("skips rather than aborting when no trace reaches it", async () => {
    const middleware = createCompactionPolicy({
      priority: 900,
      events: Bus,
      contextWindowTokens: 100,
      protectRecentMessages: 2,
    });
    for (const traceContext of [undefined, { traceId: "" }]) {
      const verdict = await middleware.fn(
        baseCtx({
          traceContext,
          messages: Array.from({ length: 12 }, (_unused, index) => createTestMessage(`m${index}`)),
          contextTokens: 900,
        }),
      );

      expect(verdict.verdict).toBe("allow");
      expect(verdict.reasonCodes).toContain("compaction_skipped_no_trace");
    }
  });
  it("continues when below threshold", async () => {
    const middleware = createCompactionPolicy({
      priority: 900,
      events: Bus,
      contextWindowTokens: 10000,
      thresholdRatio: 0.8,
    });

    const messages = [createTestMessage("msg1"), createTestMessage("msg2")];
    const ctx = baseCtx({
      messages,
      contextTokens: 1500,
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("transforms when above threshold", async () => {
    const middleware = createCompactionPolicy({
      priority: 900,
      events: Bus,
      contextWindowTokens: 1000,
      thresholdRatio: 0.8,
      protectRecentMessages: 2,
    });

    const messages = Array.from({ length: 10 }, (_, i) => createTestMessage(`msg${i}`));
    const ctx = baseCtx({
      messages,
      contextTokens: 8000,
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
    const replacement = effectOf(verdict, "run.replace_messages");
    expect(replacement).toBeDefined();
    expect(replacement?.messages.length).toBeLessThan(messages.length);
  });

  it("transforms when reserve budget is reached before ratio threshold", async () => {
    const middleware = createCompactionPolicy({
      priority: 900,
      events: Bus,
      contextWindowTokens: 1000,
      thresholdRatio: 0.95,
      reserveTokens: 250,
      protectRecentMessages: 2,
    });

    const messages = Array.from({ length: 10 }, (_, i) => createTestMessage(`msg${i}`));
    const ctx = baseCtx({
      messages,
      contextTokens: 760,
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
    const replacement = effectOf(verdict, "run.replace_messages");
    expect(replacement).toBeDefined();
    expect(replacement?.messages.length).toBeLessThan(messages.length);
  });

  it("continues when no messages in context", async () => {
    const middleware = createCompactionPolicy({
      priority: 900,
      events: Bus,
      contextWindowTokens: 1000,
      thresholdRatio: 0.8,
    });

    const ctx = baseCtx({
      messages: undefined,
      contextTokens: 8000,
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("continues when empty messages array", async () => {
    const middleware = createCompactionPolicy({
      priority: 900,
      events: Bus,
      contextWindowTokens: 1000,
      thresholdRatio: 0.8,
    });

    const ctx = baseCtx({
      messages: [],
      contextTokens: 8000,
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("skips with a recorded reason when nothing was measured", async () => {
    const middleware = createCompactionPolicy({
      priority: 900,
      events: Bus,
      contextWindowTokens: 1000,
      thresholdRatio: 0.8,
    });

    const messages = Array.from({ length: 10 }, (_, i) => createTestMessage(`msg${i}`));
    const ctx = baseCtx({
      messages,
      contextTokens: undefined,
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
    expect(verdict.reasonCodes).toContain("compaction_skipped_no_measurement");
  });

  it("carries the caller's priority — no ordering opinion of its own", () => {
    const middleware = createCompactionPolicy({
      priority: 42,
      events: Bus,
      contextWindowTokens: 1000,
    });

    expect(middleware.priority).toBe(42);
  });

  it("has name builtin:compaction", () => {
    const middleware = createCompactionPolicy({
      priority: 900,
      events: Bus,
      contextWindowTokens: 1000,
    });

    expect(middleware.name).toBe("builtin:compaction");
  });

  it("registers the canonical completion point", () => {
    const middleware = createCompactionPolicy({
      priority: 900,
      events: Bus,
      contextWindowTokens: 1000,
    });

    expect(middleware.pointIds).toEqual(["run.completion.pre"]);
    expect(middleware.effectCapabilities["run.completion.pre"]).toEqual(["run.replace_messages"]);
  });

  it("ignores run spend entirely — a huge budget with a small window stays uncompacted", async () => {
    // The regression this whole change exists to prevent: the trigger must
    // read the measured window, never the cumulative spend.
    const middleware = createCompactionPolicy({
      priority: 900,
      events: Bus,
      contextWindowTokens: 1000,
      thresholdRatio: 0.8,
      protectRecentMessages: 2,
    });
    const verdict = await middleware.fn(
      baseCtx({
        messages: Array.from({ length: 12 }, (_unused, index) => createTestMessage(`m${index}`)),
        contextTokens: 100,
        budgetState: { ...createBudgetState(), totalInputTokens: 900000, totalOutputTokens: 90000 },
      }),
    );

    expect(verdict.verdict).toBe("allow");
    expect(verdict.effects).toHaveLength(0);
  });

  it("triggers from the loop's window fact when config does not restate it", async () => {
    // The wiring PR's point: the product default carries no window — the loop
    // records the resolved model's limit, and the policy reads it from the
    // dispatch context.
    const middleware = createCompactionPolicy({
      priority: 900,
      events: Bus,
      protectRecentMessages: 2,
    });
    const verdict = await middleware.fn(
      baseCtx({
        messages: Array.from({ length: 12 }, (_unused, index) => createTestMessage(`m${index}`)),
        contextTokens: 900,
        contextWindowTokens: 1000,
      }),
    );

    expect(verdict.verdict).toBe("allow");
    expect(effectOf(verdict, "run.replace_messages")).toBeDefined();
  });

  it("skips with a recorded reason when no window is known anywhere", async () => {
    // Proxy models report limit.context 0, which the loop records as unknown.
    const middleware = createCompactionPolicy({
      priority: 900,
      events: Bus,
      protectRecentMessages: 2,
    });
    const verdict = await middleware.fn(
      baseCtx({
        messages: Array.from({ length: 12 }, (_unused, index) => createTestMessage(`m${index}`)),
        contextTokens: 900,
      }),
    );

    expect(verdict.verdict).toBe("allow");
    expect(verdict.reasonCodes).toContain("compaction_skipped_no_window");
    expect(verdict.effects).toHaveLength(0);
  });

  it("lets config narrow the loop's window, never widen the trigger away", async () => {
    const middleware = createCompactionPolicy({
      priority: 900,
      events: Bus,
      protectRecentMessages: 2,
      contextWindowTokens: 500,
    });
    const verdict = await middleware.fn(
      baseCtx({
        messages: Array.from({ length: 12 }, (_unused, index) => createTestMessage(`m${index}`)),
        contextTokens: 450,
        contextWindowTokens: 100_000,
      }),
    );

    expect(effectOf(verdict, "run.replace_messages")).toBeDefined();
  });

  it("records the boundary refusal instead of dying at a fail-closed point", async () => {
    // Assistant-first history (reachable from resumed worker hydration), no
    // summarizer, nothing elidable: the round must end as a recorded skip.
    const middleware = createCompactionPolicy({
      priority: 900,
      events: Bus,
      protectRecentMessages: 2,
    });
    const assistantOnly = Array.from({ length: 8 }, (_unused, index) => {
      const message = createTestMessage(`a${index}`);
      return { ...message, info: { ...message.info, role: "assistant" as const } };
    });
    const verdict = await middleware.fn(
      baseCtx({
        messages: assistantOnly as Parameters<PolicyFn>[0]["messages"],
        contextTokens: 900,
        contextWindowTokens: 1000,
      }),
    );

    expect(verdict.verdict).toBe("allow");
    expect(verdict.reasonCodes).toContain("compaction_skipped_no_boundary");
    expect(verdict.effects).toHaveLength(0);
  });

  it("records a triggered round that reclaimed nothing", async () => {
    // Cutoff snaps to a user message at index 0 → no cut, nothing elidable:
    // the silent path the wiring review found. A full window with no visible
    // reason is how a provider 400 arrives unexplained.
    const middleware = createCompactionPolicy({
      priority: 900,
      events: Bus,
      protectRecentMessages: 2,
    });
    const messages = [
      createTestMessage("u0"),
      ...Array.from({ length: 7 }, (_unused, index) => {
        const message = createTestMessage(`a${index}`);
        return { ...message, info: { ...message.info, role: "assistant" as const } };
      }),
    ];
    const verdict = await middleware.fn(
      baseCtx({
        messages: messages as Parameters<PolicyFn>[0]["messages"],
        contextTokens: 900,
        contextWindowTokens: 1000,
      }),
    );

    expect(verdict.verdict).toBe("allow");
    expect(verdict.reasonCodes).toContain("compaction_skipped_nothing_reclaimed");
  });
});
