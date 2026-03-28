import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Sink } from "@openomni/protocol";
import type { AgentEvent } from "../../src/core/types";
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
    calculateCost: () => ({ inputCost: 0, outputCost: 0, totalCost: 0 }),
  },
}));

let ChatAgent: typeof import("../../src/core/chat-agent").ChatAgent;

beforeAll(async () => {
  ({ ChatAgent } = await import("../../src/core/chat-agent"));
});

beforeEach(() => {
  mockRunFn = async () => createStopOutcome();
});

async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("StepGuard (stream path)", () => {
  it("emits complete event normally without guard", async () => {
    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    const events = await collectEvents(
      agent.stream({ messages: [{ role: "user", content: "hello" }] }),
    );

    const completeEvent = events.find((e) => e.type === "complete");
    expect(completeEvent).toBeDefined();
    if (completeEvent?.type === "complete") {
      expect(completeEvent.result.guardAborted).toBeUndefined();
    }
  });

  it("does not emit complete on inject, continues loop", async () => {
    let callCount = 0;
    mockRunFn = async () => {
      callCount++;
      return createStopOutcome();
    };

    let guardCount = 0;
    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      stepGuard: async () => {
        guardCount++;
        return guardCount === 1 ? { action: "inject", message: "verify" } : { action: "continue" };
      },
    });

    const events = await collectEvents(
      agent.stream({ messages: [{ role: "user", content: "task" }] }),
    );

    const completeEvents = events.filter((e) => e.type === "complete");
    expect(completeEvents).toHaveLength(1);
    expect(callCount).toBe(2);
  });

  it("emits complete with guardAborted on abort", async () => {
    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      stepGuard: async () => ({ action: "abort" }),
    });

    const events = await collectEvents(
      agent.stream({ messages: [{ role: "user", content: "hello" }] }),
    );

    const completeEvent = events.find((e) => e.type === "complete");
    expect(completeEvent).toBeDefined();
    if (completeEvent?.type === "complete") {
      expect(completeEvent.result.guardAborted).toBe(true);
    }
  });
});
