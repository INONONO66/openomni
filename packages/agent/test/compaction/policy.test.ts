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
});
