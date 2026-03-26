import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Message, Run, Sink } from "@openomni/protocol";
import type { InboundEvent } from "@openomni/protocol";

const responseQueue: string[] = [];

type MockLlmFn = (input: unknown, sink: Sink) => Promise<Run.Outcome>;

let mockRunFn: MockLlmFn = async (_input: unknown, sink: Sink) => {
  const text = responseQueue.shift() ?? "{}";
  sink.onMessage(createAssistantMessage(text));
  return { type: "stop" } as Run.Outcome;
};

const mockModelsGet = mock(async () => ({
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-3-haiku-20240307": {
        id: "claude-3-haiku-20240307",
        name: "Claude 3 Haiku",
      },
    },
  },
}));

const mockProviderFromModelsDevModel = mock(() => ({
  id: "claude-3-haiku-20240307",
  providerID: "anthropic",
}));

mock.module("@openomni/llm", () => ({
  ModelsDev: { get: mockModelsGet },
  Provider: { fromModelsDevModel: mockProviderFromModelsDevModel },
  run: (input: unknown, sink: Sink) => mockRunFn(input, sink),
  TokenTracker: {
    extractUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
    calculateCost: () => ({ inputCost: 0, outputCost: 0, totalCost: 0 }),
  },
}));

let IngressEngine: typeof import("../../src/ingress/engine").IngressEngine;

beforeAll(async () => {
  ({ IngressEngine } = await import("../../src/ingress/engine"));
});

beforeEach(() => {
  responseQueue.length = 0;
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
  mockRunFn = async (_input: unknown, sink: Sink) => {
    const text = responseQueue.shift() ?? "{}";
    sink.onMessage(createAssistantMessage(text));
    return { type: "stop" } as Run.Outcome;
  };
  IngressEngine.reset();
});

function createAssistantMessage(text: string): Message.WithParts {
  const id = crypto.randomUUID();
  const sessionID = "engine-test";
  const now = Date.now();

  const info: Message.AssistantMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: now },
    parentID: "",
    modelID: "claude-3-haiku-20240307",
    providerID: "anthropic",
    agent: "chat-agent",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: {
      input: 1,
      output: 1,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };

  const textPart: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "text",
    text,
  };

  return { info, parts: [textPart] };
}

function enqueuePlan(goal: string): void {
  responseQueue.push(
    JSON.stringify({
      planId: crypto.randomUUID(),
      goal,
      steps: [
        {
          stepId: "s1",
          description: "Execute step",
          expectedOutput: "done",
          dependsOn: [],
        },
      ],
      createdAt: new Date().toISOString(),
      version: 1,
    }),
  );
}

describe("IngressEngine", () => {
  it("ingest() with plan mode returns plan result", async () => {
    enqueuePlan("Create delivery plan");

    const event: InboundEvent = {
      id: "event-plan-1",
      surface: "tui",
      workspace: "/repo",
      mode: "plan",
      payload: "Create delivery plan",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };

    const result = await IngressEngine.ingest(event);

    expect(result.mode).toBe("plan");
    if (result.mode !== "plan") {
      throw new Error("Expected plan mode result");
    }
    expect(result.sessionId).toBeString();
    expect(result.result.plan.goal).toBe("Create delivery plan");
  });

  it("ingest() with team mode returns team result", async () => {
    enqueuePlan("Execute release checks");
    responseQueue.push("executor output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const planEvent: InboundEvent = {
      id: "event-team-plan",
      surface: "tui",
      workspace: "/repo",
      mode: "plan",
      payload: "Execute release checks",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };

    const planResult = await IngressEngine.ingest(planEvent);

    const teamEvent: InboundEvent = {
      id: "event-team-run",
      surface: "tui",
      workspace: "/repo",
      mode: "team",
      payload: "run",
      agents: {
        reviewer: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
        executor: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
      },
    };

    const result = await IngressEngine.ingest(teamEvent);

    expect(planResult.sessionId).toBe(result.sessionId);
    expect(result.mode).toBe("team");
    if (result.mode !== "team") {
      throw new Error("Expected team mode result");
    }
    expect(result.result.status).toBe("completed");
    expect(result.result.completedSteps).toEqual(["s1"]);
  });

  it("ingest() with direct mode returns direct result", async () => {
    responseQueue.push("direct response");

    const event: InboundEvent = {
      id: "event-direct-1",
      surface: "slack",
      workspace: "team-a",
      channel: "C1",
      mode: "direct",
      payload: "hello",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };

    const result = await IngressEngine.ingest(event);

    expect(result.mode).toBe("direct");
    if (result.mode !== "direct") {
      throw new Error("Expected direct mode result");
    }
    expect(result.result.output).toBe("direct response");
    expect(result.result.finishReason).toBe("stop");
  });

  it("ingest() with invalid event throws", async () => {
    await expect(
      IngressEngine.ingest({
        id: "invalid-1",
        surface: "tui",
        payload: "hello",
      } as unknown as InboundEvent),
    ).rejects.toThrow();
  });

  it("reuses session for same surface key across calls", async () => {
    enqueuePlan("First plan");
    enqueuePlan("Second plan");

    const eventA: InboundEvent = {
      id: "event-reuse-1",
      surface: "tui",
      workspace: "/repo",
      channel: "main",
      mode: "plan",
      payload: "First plan",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };

    const eventB: InboundEvent = {
      id: "event-reuse-2",
      surface: "tui",
      workspace: "/repo",
      channel: "main",
      mode: "plan",
      payload: "Second plan",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };

    const first = await IngressEngine.ingest(eventA);
    const second = await IngressEngine.ingest(eventB);

    expect(first.sessionId).toBe(second.sessionId);
  });

  it("reset() clears session mapping state", async () => {
    enqueuePlan("Plan before reset");
    enqueuePlan("Plan after reset");

    const event: InboundEvent = {
      id: "event-reset-1",
      surface: "tui",
      workspace: "/repo",
      mode: "plan",
      payload: "Plan before reset",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };

    const first = await IngressEngine.ingest(event);
    IngressEngine.reset();

    const second = await IngressEngine.ingest({
      ...event,
      id: "event-reset-2",
      payload: "Plan after reset",
    });

    expect(first.sessionId).not.toBe(second.sessionId);
  });
});
