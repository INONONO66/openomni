import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import { Message } from "@openomni/protocol";
import type { InboundEvent, Plan } from "@openomni/protocol";
import { Bus, Session, Storage, SurfaceKey } from "@openomni/session";

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

const mockLlmRun = mock(async () => ({ type: "stop" as const }));

mock.module("@openomni/llm", () => ({
  ModelsDev: { get: mockModelsGet },
  Provider: { fromModelsDevModel: mockProviderFromModelsDevModel },
  run: mockLlmRun,
}));

let IngressHandlers: typeof import("../../src/ingress/handlers").IngressHandlers;
let PlanAgent: typeof import("../../src/plan/plan-agent").PlanAgent;
let TeamOrchestrator: typeof import("../../src/team/team-orchestrator").TeamOrchestrator;
let ChatAgent: typeof import("@openomni/agent").ChatAgent;
let SessionBridge: typeof import("../../src/ingress/session-bridge").SessionBridge;

const originalFns: {
  planGenerate?: typeof import("../../src/plan/plan-agent").PlanAgent.generate;
  teamExecute?: typeof import("../../src/team/team-orchestrator").TeamOrchestrator.execute;
  chatCreate?: typeof import("@openomni/agent").ChatAgent.create;
  buildPlanGoal?: typeof import("../../src/ingress/session-bridge").SessionBridge.buildPlanGoal;
  storePlanResult?: typeof import("../../src/ingress/session-bridge").SessionBridge.storePlanResult;
  storeTeamResult?: typeof import("../../src/ingress/session-bridge").SessionBridge.storeTeamResult;
  storeDirectResult?: typeof import("../../src/ingress/session-bridge").SessionBridge.storeDirectResult;
} = {};

beforeAll(async () => {
  ({ IngressHandlers } = await import("../../src/ingress/handlers"));
  ({ PlanAgent } = await import("../../src/plan/plan-agent"));
  ({ TeamOrchestrator } = await import("../../src/team/team-orchestrator"));
  ({ ChatAgent } = await import("@openomni/agent"));
  ({ SessionBridge } = await import("../../src/ingress/session-bridge"));

  originalFns.planGenerate = PlanAgent.generate;
  originalFns.teamExecute = TeamOrchestrator.execute;
  originalFns.chatCreate = ChatAgent.create;
  originalFns.buildPlanGoal = SessionBridge.buildPlanGoal;
  originalFns.storePlanResult = SessionBridge.storePlanResult;
  originalFns.storeTeamResult = SessionBridge.storeTeamResult;
  originalFns.storeDirectResult = SessionBridge.storeDirectResult;
});

beforeEach(() => {
  SurfaceKey.clear();
  Storage.reset();
  Bus.reset();
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
  mockLlmRun.mockClear();
});

afterEach(() => {
  if (originalFns.planGenerate) PlanAgent.generate = originalFns.planGenerate;
  if (originalFns.teamExecute)
    TeamOrchestrator.execute = originalFns.teamExecute;
  if (originalFns.chatCreate) ChatAgent.create = originalFns.chatCreate;
  if (originalFns.buildPlanGoal)
    SessionBridge.buildPlanGoal = originalFns.buildPlanGoal;
  if (originalFns.storePlanResult) {
    SessionBridge.storePlanResult = originalFns.storePlanResult;
  }
  if (originalFns.storeTeamResult) {
    SessionBridge.storeTeamResult = originalFns.storeTeamResult;
  }
  if (originalFns.storeDirectResult) {
    SessionBridge.storeDirectResult = originalFns.storeDirectResult;
  }
});

function createSession(): string {
  return Session.create({
    title: "Handlers Test Session",
    model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
  }).id;
}

function addTextMessage(
  sessionId: string,
  role: "user" | "assistant",
  text: string,
): void {
  if (role === "user") {
    const message: Message.UserMessage = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      role: "user",
      time: { created: Date.now() },
      agent: "test-user",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    };
    Session.addMessage(sessionId, message);
    const part: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: message.id,
      type: "text",
      text,
    };
    Session.addPart(message.id, part);
    return;
  }

  const message: Message.AssistantMessage = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: "claude-3-haiku-20240307",
    providerID: "anthropic",
    agent: "test-assistant",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
  Session.addMessage(sessionId, message);
  const part: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: message.id,
    type: "text",
    text,
  };
  Session.addPart(message.id, part);
}

function createPlan(): Plan {
  return {
    planId: "plan-handlers-1",
    goal: "Deliver ingress handlers",
    steps: [
      {
        stepId: "s1",
        description: "Create handlers",
        expectedOutput: "handlers.ts",
        dependsOn: [],
      },
    ],
    createdAt: new Date("2026-03-08T00:00:00.000Z"),
    version: 1,
  };
}

describe("IngressHandlers", () => {
  it("handlePlan returns mode=plan with PlanResult", async () => {
    const sessionId = createSession();
    addTextMessage(sessionId, "user", "Plan this work");

    const plan = createPlan();
    const generateMock = mock(async () => ({ plan }));
    PlanAgent.generate = generateMock;

    const event: InboundEvent = {
      id: "event-plan-1",
      surface: "tui",
      mode: "plan",
      payload: "payload",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };

    const result = await IngressHandlers.handlePlan({ sessionId, event });

    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe("plan");
    expect(result.sessionId).toBe(sessionId);
    expect(result.result.plan.planId).toBe(plan.planId);
  });

  it("handlePlan builds goal and stores plan result", async () => {
    const sessionId = createSession();
    const buildPlanGoalMock = mock(() => "goal-from-session");
    const plan = createPlan();
    const planResult = { plan };
    const generateMock = mock(async () => planResult);
    const storePlanResultMock = mock(() => {});

    SessionBridge.buildPlanGoal = buildPlanGoalMock;
    PlanAgent.generate = generateMock;
    SessionBridge.storePlanResult = storePlanResultMock;

    const event: InboundEvent = {
      id: "event-plan-2",
      surface: "tui",
      mode: "plan",
      payload: "payload",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        systemPrompt: "planner system",
        budget: { maxTurns: 2 },
      },
    };

    await IngressHandlers.handlePlan({ sessionId, event });

    expect(buildPlanGoalMock).toHaveBeenCalledWith(sessionId);
    expect(generateMock).toHaveBeenCalledWith("goal-from-session", {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      systemPrompt: "planner system",
      budget: { maxTurns: 2 },
    });
    expect(storePlanResultMock).toHaveBeenCalledWith(
      sessionId,
      planResult,
      event.agent.model,
    );
  });

  it("handleTeam executes extracted plan and returns team result", async () => {
    const sessionId = createSession();
    const reviewerModel = {
      provider: "anthropic",
      id: "claude-3-haiku-20240307",
    };
    const executorModel = {
      provider: "anthropic",
      id: "claude-3-haiku-20240307",
    };
    const plan = createPlan();
    SessionBridge.storePlanResult(sessionId, { plan }, reviewerModel);

    const teamResult: import("../../src/team/team-orchestrator").TeamOrchestrator.TeamResult =
      {
        status: "completed",
        completedSteps: ["s1"],
        failedSteps: [],
        skippedSteps: [],
        results: new Map([["s1", "done"]]),
      };

    const executeMock = mock(async () => teamResult);
    const storeTeamResultMock = mock(() => {});
    TeamOrchestrator.execute = executeMock;
    SessionBridge.storeTeamResult = storeTeamResultMock;

    const event: InboundEvent = {
      id: "event-team-1",
      surface: "tui",
      mode: "team",
      payload: "payload",
      agents: {
        reviewer: {
          model: reviewerModel,
          systemPrompt: "review prompt",
        },
        executor: {
          model: executorModel,
          systemPrompt: "execute prompt",
          tools: [],
        },
      },
    };

    const result = await IngressHandlers.handleTeam({ sessionId, event });

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(
      plan,
      expect.objectContaining({
        reviewModel: reviewerModel,
        reviewSystemPrompt: "review prompt",
        defaultTeammateConfig: expect.objectContaining({
          agentId: "executor",
          model: executorModel,
          systemPrompt: "execute prompt",
          tools: [],
        }),
      }),
    );
    expect(storeTeamResultMock).toHaveBeenCalledWith(
      sessionId,
      teamResult,
      reviewerModel,
    );
    expect(result.mode).toBe("team");
    expect(result.result).toEqual({
      ...teamResult,
      results: Object.fromEntries(teamResult.results),
    });
  });

  it("handleTeam throws when no plan exists in session", async () => {
    const sessionId = createSession();
    const executeMock = mock(async () => {
      throw new Error("should not be called");
    });
    TeamOrchestrator.execute = executeMock;

    const event: InboundEvent = {
      id: "event-team-2",
      surface: "tui",
      mode: "team",
      payload: "payload",
      agents: {
        reviewer: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
        executor: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
      },
    };

    await expect(
      IngressHandlers.handleTeam({ sessionId, event }),
    ).rejects.toThrow(/No plan found in session/);
    expect(executeMock).toHaveBeenCalledTimes(0);
  });

  it("handleDirect runs ChatAgent with session messages and stores output", async () => {
    const sessionId = createSession();
    addTextMessage(sessionId, "user", "hello");
    addTextMessage(sessionId, "assistant", "hi");
    addTextMessage(sessionId, "user", "summarize");

    const runMock = mock(async ({ messages }: { messages: unknown[] }) => ({
      text: "direct output",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: "stop" as const,
      received: messages,
    }));
    const createMock = mock(() => ({
      run: runMock,
      async *stream() {
        return;
      },
    }));
    const storeDirectResultMock = mock(() => {});

    ChatAgent.create = createMock as unknown as typeof ChatAgent.create;
    SessionBridge.storeDirectResult = storeDirectResultMock;

    const toolExecutor = async () => ({
      id: crypto.randomUUID(),
      toolCallId: "tool-call-1",
      output: "ok",
      isError: false,
    });
    const event: InboundEvent = {
      id: "event-direct-1",
      surface: "tui",
      mode: "direct",
      payload: "payload",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        systemPrompt: "direct system",
        tools: [],
        budget: { maxTurns: 3 },
        toolExecutor,
      },
    };

    const result = await IngressHandlers.handleDirect({ sessionId, event });

    expect(createMock).toHaveBeenCalledWith({
      model: event.agent.model,
      systemPrompt: "direct system",
      tools: [],
      budget: { maxTurns: 3 },
      toolExecutor,
    });
    expect(runMock).toHaveBeenCalledWith({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "summarize" },
      ],
    });
    expect(storeDirectResultMock).toHaveBeenCalledWith(
      sessionId,
      "direct output",
      event.agent.model,
    );
    expect(result).toEqual({
      mode: "direct",
      sessionId,
      result: {
        output: "direct output",
        finishReason: "stop",
      },
    });
  });
});
