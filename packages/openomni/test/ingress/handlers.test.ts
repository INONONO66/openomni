import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Message, Ingress, Plan } from "@openomni/protocol";
import { Bus, Session, Storage, SurfaceKey } from "@openomni/session";
import { mockModelsGet, mockProviderFromModelsDevModel, resetTestState } from "./_llm-mock";

let IngressHandlers: typeof import("../../src/ingress/handlers").IngressHandlers;
let PlanAgent: typeof import("../../src/plan/plan-agent").PlanAgent;
let ChatAgent: typeof import("@openomni/agent").ChatAgent;
let SessionBridge: typeof import("../../src/ingress/session-bridge").SessionBridge;

const originalFns: {
  planGenerate?: typeof import("../../src/plan/plan-agent").PlanAgent.generate;
  chatCreate?: typeof import("@openomni/agent").ChatAgent.create;
  buildPlanGoal?: typeof import("../../src/ingress/session-bridge").SessionBridge.buildPlanGoal;
  storePlanResult?: typeof import("../../src/ingress/session-bridge").SessionBridge.storePlanResult;
  storeDirectResult?: typeof import("../../src/ingress/session-bridge").SessionBridge.storeDirectResult;
} = {};

beforeAll(async () => {
  ({ IngressHandlers } = await import("../../src/ingress/handlers"));
  ({ PlanAgent } = await import("../../src/plan/plan-agent"));
  ({ ChatAgent } = await import("@openomni/agent"));
  ({ SessionBridge } = await import("../../src/ingress/session-bridge"));

  originalFns.planGenerate = PlanAgent.generate;
  originalFns.chatCreate = ChatAgent.create;
  originalFns.buildPlanGoal = SessionBridge.buildPlanGoal;
  originalFns.storePlanResult = SessionBridge.storePlanResult;
  originalFns.storeDirectResult = SessionBridge.storeDirectResult;
});

beforeEach(() => {
  SurfaceKey.clear();
  Storage.reset();
  Bus.reset();
  resetTestState();
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
});

afterEach(() => {
  if (originalFns.planGenerate) PlanAgent.generate = originalFns.planGenerate;
  if (originalFns.chatCreate) ChatAgent.create = originalFns.chatCreate;
  if (originalFns.buildPlanGoal) SessionBridge.buildPlanGoal = originalFns.buildPlanGoal;
  if (originalFns.storePlanResult) {
    SessionBridge.storePlanResult = originalFns.storePlanResult;
  }
  if (originalFns.storeDirectResult) {
    SessionBridge.storeDirectResult = originalFns.storeDirectResult;
  }
});

afterAll(() => {
  mock.restore();
});

function createSession(): string {
  return Session.create({
    title: "Handlers Test Session",
    model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
  }).id;
}

function addTextMessage(sessionId: string, role: "user" | "assistant", text: string): void {
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
  it("buildExecutionRequest preserves tool execution config", () => {
    const toolConfig = { workspaceRoot: "/workspace/openomni" };
    const permissions = { denylist: ["bash"] };
    const event: Ingress.InboundEvent = {
      id: "event-request-1",
      surface: "tui",
      mode: "direct",
      payload: "payload",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        tools: [{ name: "bash", inputSchema: { type: "object" } }],
        toolConfig,
        permissions,
      },
    };

    const request = IngressHandlers.buildExecutionRequest({
      sessionId: "session-1",
      event,
    });

    expect(request.tools).toEqual(event.agent.tools);
    expect(request.toolConfig).toEqual(toolConfig);
    expect(request.permissions).toEqual(permissions);
  });

  it("handlePlan returns mode=plan with PlanResult", async () => {
    const sessionId = createSession();
    addTextMessage(sessionId, "user", "Plan this work");

    const plan = createPlan();
    const generateMock = mock(async () => ({ plan }));
    PlanAgent.generate = generateMock;

    const event: Ingress.InboundEvent = {
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

    const event: Ingress.InboundEvent = {
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
    expect(storePlanResultMock).toHaveBeenCalledWith(sessionId, planResult, event.agent.model);
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
    const event: Ingress.InboundEvent = {
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
