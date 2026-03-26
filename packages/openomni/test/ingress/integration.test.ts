import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { InboundEvent, Message, Run, Sink } from "@openomni/protocol";
import { ZodError } from "zod";

const responseQueue: string[] = [];
const llmInputs: unknown[] = [];

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
  run: (input: unknown, sink: Sink) => {
    llmInputs.push(input);
    return mockRunFn(input, sink);
  },
  TokenTracker: {
    extractUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
    calculateCost: () => ({ inputCost: 0, outputCost: 0, totalCost: 0 }),
  },
}));

let IngressEngine: typeof import("../../src/ingress/engine").IngressEngine;
let SessionBridge: typeof import("../../src/ingress/session-bridge").SessionBridge;

beforeAll(async () => {
  ({ IngressEngine } = await import("../../src/ingress/engine"));
  ({ SessionBridge } = await import("../../src/ingress/session-bridge"));
});

beforeEach(() => {
  responseQueue.length = 0;
  llmInputs.length = 0;
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
  const sessionID = "integration-test";
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

function enqueuePlan(planId: string, goal: string, stepId: string): void {
  responseQueue.push(
    JSON.stringify({
      planId,
      goal,
      steps: [
        {
          stepId,
          description: `Do ${stepId}`,
          expectedOutput: `${stepId} done`,
          dependsOn: [],
        },
      ],
      createdAt: "2024-01-01T00:00:00.000Z",
      version: 1,
    }),
  );
}

function extractTextMessages(input: unknown): Array<{ role: string; content: string }> {
  if (!input || typeof input !== "object") {
    return [];
  }

  const candidate = input as {
    messages?: Array<{
      info?: { role?: string };
      parts?: Array<{ type?: string; text?: string }>;
    }>;
  };
  const messages = candidate.messages ?? [];

  return messages.flatMap((message) => {
    const role = message.info?.role;
    if (typeof role !== "string") {
      return [];
    }

    return (message.parts ?? [])
      .filter(
        (part): part is { type: "text"; text: string } =>
          part.type === "text" && typeof part.text === "string",
      )
      .map((part) => ({ role, content: part.text }));
  });
}

describe("IngressEngine integration pipeline", () => {
  describe("plan -> re-plan -> team lifecycle", () => {
    it("reuses session and executes latest stored plan", async () => {
      enqueuePlan("plan-1", "Build a REST API", "step-1");
      enqueuePlan("plan-2", "Add auth to step 2", "step-2");
      responseQueue.push("executor output");
      responseQueue.push(JSON.stringify({ decision: "accept" }));

      const first = await IngressEngine.ingest({
        id: "evt-plan-1",
        mode: "plan",
        surface: "tui",
        workspace: "/project",
        payload: "Build a REST API",
        agent: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
      });

      expect(first.mode).toBe("plan");
      if (first.mode !== "plan") {
        throw new Error("Expected plan mode result");
      }
      const firstStoredPlan = SessionBridge.extractPlan(first.sessionId);
      expect(firstStoredPlan.goal).toBe("Build a REST API");

      const second = await IngressEngine.ingest({
        id: "evt-plan-2",
        mode: "plan",
        surface: "tui",
        workspace: "/project",
        payload: "Add auth to step 2",
        agent: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
      });

      expect(second.mode).toBe("plan");
      if (second.mode !== "plan") {
        throw new Error("Expected plan mode result");
      }

      const replanInput = llmInputs[1];
      const replanMessages = extractTextMessages(replanInput);
      const replanGoal = replanMessages.map((message) => message.content).join("\n");
      expect(replanGoal).toContain("Previous plan:");
      expect(replanGoal).toContain("Build a REST API");
      expect(replanGoal).toContain("User feedback:");
      expect(replanGoal).toContain("Add auth to step 2");

      const team = await IngressEngine.ingest({
        id: "evt-team-1",
        mode: "team",
        surface: "tui",
        workspace: "/project",
        payload: "execute",
        agents: {
          reviewer: {
            model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
          },
          executor: {
            model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
          },
        },
      });

      expect(team.mode).toBe("team");
      if (team.mode !== "team") {
        throw new Error("Expected team mode result");
      }
      expect(team.result.status).toBe("completed");
      expect(team.result.completedSteps).toEqual(["step-2"]);

      expect(first.sessionId).toBe(second.sessionId);
      expect(second.sessionId).toBe(team.sessionId);
    });
  });

  describe("direct mode conversation history", () => {
    it("sends accumulated user history on second turn", async () => {
      responseQueue.push("Hi there");
      responseQueue.push("Sure, what do you need?");

      const first = await IngressEngine.ingest({
        id: "evt-direct-1",
        mode: "direct",
        surface: "slack",
        workspace: "team-a",
        channel: "C123",
        payload: "Hello",
        agent: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
      });

      const second = await IngressEngine.ingest({
        id: "evt-direct-2",
        mode: "direct",
        surface: "slack",
        workspace: "team-a",
        channel: "C123",
        payload: "Follow up",
        agent: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
      });

      const secondInput = llmInputs[1];
      const secondMessages = extractTextMessages(secondInput);
      const secondUserMessages = secondMessages.filter((message) => message.role === "user");

      expect(secondUserMessages).toHaveLength(2);
      expect(secondUserMessages[0]?.content).toBe("Hello");
      expect(secondUserMessages[1]?.content).toBe("Follow up");
      expect(first.sessionId).toBe(second.sessionId);
    });
  });

  describe("session isolation", () => {
    it("does not leak plan context across different surface keys", async () => {
      enqueuePlan("plan-a", "Plan A", "step-a");
      enqueuePlan("plan-b", "Plan B", "step-b");

      const first = await IngressEngine.ingest({
        id: "evt-isolation-a",
        mode: "plan",
        surface: "tui",
        workspace: "/project-a",
        payload: "Plan A",
        agent: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
      });

      const second = await IngressEngine.ingest({
        id: "evt-isolation-b",
        mode: "plan",
        surface: "tui",
        workspace: "/project-b",
        payload: "Plan B",
        agent: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
      });

      expect(first.sessionId).not.toBe(second.sessionId);
      const planA = SessionBridge.extractPlan(first.sessionId);
      const planB = SessionBridge.extractPlan(second.sessionId);
      expect(planA.goal).toBe("Plan A");
      expect(planB.goal).toBe("Plan B");

      const replanInputForProjectB = llmInputs[1];
      const replanMessagesForProjectB = extractTextMessages(replanInputForProjectB)
        .map((message) => message.content)
        .join("\n");
      expect(replanMessagesForProjectB).not.toContain("Previous plan:");
      expect(replanMessagesForProjectB).toContain("Plan B");
    });
  });

  describe("error cases", () => {
    it("throws when team mode runs without stored plan", async () => {
      await expect(
        IngressEngine.ingest({
          id: "evt-no-plan-team",
          mode: "team",
          surface: "tui",
          workspace: "/project",
          payload: "execute",
          agents: {
            reviewer: {
              model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
            },
            executor: {
              model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
            },
          },
        }),
      ).rejects.toThrow(/No plan/);
    });

    it("throws zod error when mode is missing", async () => {
      const invalidEvent = {
        id: "evt-invalid-no-mode",
        surface: "tui",
        payload: "hello",
      };

      await expect(
        IngressEngine.ingest(invalidEvent as unknown as InboundEvent),
      ).rejects.toBeInstanceOf(ZodError);
    });
  });
});
