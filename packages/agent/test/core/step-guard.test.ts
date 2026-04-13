import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Sink } from "@openomni/protocol";
import type { StepGuardContext } from "../../src/core/types";
import {
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
  type MockLlmFn,
} from "../helpers/mock-llm";

let mockRunFn: MockLlmFn = async () => createStopOutcome();

mock.module("@openomni/llm", () => ({
  ModelsDev: { get: mock(async () => mockProviderData) },
  Provider: { fromModelsDevModel: mock(() => mockProviderModel) },
  run: (input: unknown, sink: Sink) => mockRunFn(input, sink),
  TokenTracker: {
    extractUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
  },
  ProviderTransform: {
    resolveVariant: () => ({}),
  },
}));

let ChatAgent: typeof import("../../src/core/chat-agent").ChatAgent;

beforeAll(async () => {
  ({ ChatAgent } = await import("../../src/core/chat-agent"));
});

beforeEach(() => {
  mockRunFn = async () => createStopOutcome();
});

describe("StepGuard (run path)", () => {
  it("runs normally when no stepGuard configured", async () => {
    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });
    const result = await agent.run({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.finishReason).toBe("stop");
    expect(result.guardAborted).toBeUndefined();
  });

  it("stops normally when guard returns continue", async () => {
    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      stepGuard: async () => ({ action: "continue" }),
    });
    const result = await agent.run({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.finishReason).toBe("stop");
    expect(result.guardAborted).toBeUndefined();
  });

  it("injects message and continues when guard returns inject", async () => {
    let callCount = 0;
    mockRunFn = async () => {
      callCount++;
      return createStopOutcome();
    };

    let guardCallCount = 0;
    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      stepGuard: async () => {
        guardCallCount++;
        if (guardCallCount === 1) {
          return { action: "inject", message: "Please verify your work." };
        }
        return { action: "continue" };
      },
    });

    const result = await agent.run({
      messages: [{ role: "user", content: "do task" }],
    });
    expect(result.finishReason).toBe("stop");
    expect(result.guardAborted).toBeUndefined();
    expect(callCount).toBe(2);
    expect(guardCallCount).toBe(2);
  });

  it("returns with guardAborted when guard aborts", async () => {
    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      stepGuard: async () => ({ action: "abort", reason: "too long" }),
    });
    const result = await agent.run({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.finishReason).toBe("stop");
    expect(result.guardAborted).toBe(true);
  });

  it("provides correct context to guard", async () => {
    let capturedContext: StepGuardContext | null = null;
    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      stepGuard: async (_step, ctx) => {
        capturedContext = ctx;
        return { action: "continue" };
      },
    });
    await agent.run({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(capturedContext).not.toBeNull();
    if (!capturedContext) {
      throw new Error("Expected step guard context");
    }
    expect(capturedContext.isCompletion).toBe(true);
    expect(capturedContext.continuationCount).toBe(0);
    expect(capturedContext.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("increments continuationCount on each inject", async () => {
    mockRunFn = async () => createStopOutcome();

    const capturedCounts: number[] = [];
    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      stepGuard: async (_step, ctx) => {
        capturedCounts.push(ctx.continuationCount);
        if (ctx.continuationCount < 2) {
          return { action: "inject", message: "keep going" };
        }
        return { action: "continue" };
      },
    });
    await agent.run({
      messages: [{ role: "user", content: "task" }],
    });
    expect(capturedCounts).toEqual([0, 1, 2]);
  });

  it("propagates error when guard throws", async () => {
    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      stepGuard: async () => {
        throw new Error("guard error");
      },
    });
    await expect(agent.run({ messages: [{ role: "user", content: "hello" }] })).rejects.toThrow(
      "guard error",
    );
  });
});
