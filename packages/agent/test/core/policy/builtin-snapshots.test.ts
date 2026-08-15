import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import type { BudgetState } from "../../../src/core/budget";
import type { PolicyFn } from "../../../src/core/policy";
import { createCompactionPolicy } from "../../../src/compaction";
import { Bus } from "@openomni/telemetry";

function baseCtx(overrides?: Partial<Parameters<PolicyFn>[0]>): Parameters<PolicyFn>[0] {
  return {
    timing: "turn.start",
    pointId: "run.turn.pre",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

function budgetState(overrides?: Partial<BudgetState>): BudgetState {
  return {
    startTime: Date.now(),
    turns: 0,
    toolCalls: 0,
    toolRuntimeMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    ...overrides,
  };
}

function testMessage(id: string): Message.WithParts {
  return {
    info: {
      id,
      sessionID: "test-session",
      role: "user" as const,
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
        type: "text" as const,
        text: `Test message ${id}`,
      },
    ],
  };
}

describe("snapshot: compaction", () => {
  it("continue — below token threshold", async () => {
    const mw = createCompactionPolicy({
      events: Bus,
      contextWindowTokens: 10000,
      thresholdRatio: 0.8,
    });
    const verdict = await mw.fn(
      baseCtx({
        pointId: "run.completion.pre",
        messages: [testMessage("m1"), testMessage("m2")],
        budgetState: budgetState({ totalInputTokens: 1000, totalOutputTokens: 500 }),
      }),
    );
    expect(verdict.verdict).toBe("allow");
  });
});

describe("snapshot: canonical registration metadata", () => {
  it("compaction: name, point, priority", () => {
    const mw = createCompactionPolicy({ events: Bus, contextWindowTokens: 1000 });
    expect(mw.name).toBe("builtin:compaction");
    expect(mw.pointIds).toEqual(["run.completion.pre"]);
    expect(mw.effectCapabilities).toEqual({
      "run.completion.pre": ["run.replace_messages"],
    });
    expect(mw.priority).toBe(900);
  });
});
