import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentResult } from "@openomni/agent";
import type { Plan, PlanStep, Team } from "@openomni/protocol";
import type { Teammate } from "../../src/team/teammate";

const responseQueue: string[] = [];
const publishedEvents: Array<{ eventName: string; data: unknown }> = [];

// Mock Bus.publish to capture events
mock.module("@openomni/session", () => ({
  Bus: {
    publish: (event: { name: string }, data: unknown) => {
      publishedEvents.push({ eventName: event.name, data });
    },
    subscribe: () => () => {},
    reset: () => {},
  },
}));

// Mock ChatAgent for deterministic responses
mock.module("@openomni/agent", () => ({
  ChatAgent: {
    create: () => ({
      run: async () => {
        const text = responseQueue.shift() ?? "{}";
        return {
          text,
          steps: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          },
          finishReason: "stop",
        } as AgentResult;
      },
    }),
  },
}));

const { TeamOrchestrator } = await import("../../src/team/team-orchestrator");

beforeEach(() => {
  responseQueue.length = 0;
  publishedEvents.length = 0;
});

function makeStep(
  stepId: string,
  dependsOn: string[] = [],
  suggestedAgent?: string,
): PlanStep {
  return {
    stepId,
    description: `${stepId} task`,
    expectedOutput: `${stepId} output`,
    dependsOn,
    suggestedAgent,
  };
}

function makePlan(steps: PlanStep[]): Plan {
  return {
    planId: "plan-1",
    goal: "execute plan",
    steps,
    createdAt: new Date(),
    version: 1,
  };
}

const defaultTeammateConfig: Teammate.TeammateConfig = {
  agentId: "default-agent",
  model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
};

function makeConfig(overrides?: {
  teammates?: Map<string, Teammate.TeammateConfig>;
  maxAttemptsPerStep?: number;
}) {
  return {
    reviewModel: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    teammates:
      overrides?.teammates ?? new Map<string, Teammate.TeammateConfig>(),
    defaultTeammateConfig,
    maxAttemptsPerStep: overrides?.maxAttemptsPerStep,
  };
}

describe("TeamOrchestrator event stream", () => {
  it("publishes plan.created when execute() starts", async () => {
    responseQueue.push("step output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1")]);
    await TeamOrchestrator.execute(plan, makeConfig());

    const planCreatedEvent = publishedEvents.find(
      (e) => e.eventName === "plan.created",
    );
    expect(planCreatedEvent).toBeDefined();
    expect(planCreatedEvent?.data).toMatchObject({
      payload: {
        planId: "plan-1",
        goal: "execute plan",
        stepCount: 1,
      },
    });
  });

  it("publishes step.assigned for each step", async () => {
    responseQueue.push("s1 output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));
    responseQueue.push("s2 output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1"), makeStep("s2")]);
    await TeamOrchestrator.execute(plan, makeConfig());

    const assignedEvents = publishedEvents.filter(
      (e) => e.eventName === "step.assigned",
    );
    expect(assignedEvents.length).toBe(2);
    expect(assignedEvents[0]?.data).toMatchObject({
      payload: {
        planId: "plan-1",
        stepId: "s1",
        agentId: "default-agent",
      },
    });
    expect(assignedEvents[1]?.data).toMatchObject({
      payload: {
        planId: "plan-1",
        stepId: "s2",
        agentId: "default-agent",
      },
    });
  });

  it("publishes step.started before Teammate.execute()", async () => {
    responseQueue.push("step output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1")]);
    await TeamOrchestrator.execute(plan, makeConfig());

    const startedEvent = publishedEvents.find(
      (e) => e.eventName === "step.started",
    );
    expect(startedEvent).toBeDefined();
    expect(startedEvent?.data).toMatchObject({
      payload: {
        planId: "plan-1",
        stepId: "s1",
        agentId: "default-agent",
        attempt: 1,
      },
    });
  });

  it("publishes step.completed when step is accepted", async () => {
    responseQueue.push("step output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1")]);
    await TeamOrchestrator.execute(plan, makeConfig());

    const completedEvent = publishedEvents.find(
      (e) => e.eventName === "step.completed",
    );
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.data).toMatchObject({
      payload: {
        planId: "plan-1",
        stepId: "s1",
        result: "step output",
      },
    });
  });

  it("publishes review.decision after each review", async () => {
    responseQueue.push("s1 output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1")]);
    await TeamOrchestrator.execute(plan, makeConfig());

    const decisionEvent = publishedEvents.find(
      (e) => e.eventName === "review.decision",
    );
    expect(decisionEvent).toBeDefined();
    expect(decisionEvent?.data).toMatchObject({
      payload: {
        planId: "plan-1",
        stepId: "s1",
        decision: "accept",
      },
    });
  });

  it("publishes step.failed when max attempts reached", async () => {
    responseQueue.push("attempt 1");
    responseQueue.push(JSON.stringify({ decision: "reject" }));
    responseQueue.push("attempt 2");
    responseQueue.push(JSON.stringify({ decision: "reject" }));
    responseQueue.push("attempt 3");
    responseQueue.push(JSON.stringify({ decision: "reject" }));

    const plan = makePlan([makeStep("s1")]);
    await TeamOrchestrator.execute(plan, makeConfig({ maxAttemptsPerStep: 3 }));

    const failedEvent = publishedEvents.find(
      (e) => e.eventName === "step.failed",
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.data).toMatchObject({
      payload: {
        planId: "plan-1",
        stepId: "s1",
      },
    });
  });

  it("publishes execution.complete when done", async () => {
    responseQueue.push("step output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1")]);
    await TeamOrchestrator.execute(plan, makeConfig());

    const completeEvent = publishedEvents.find(
      (e) => e.eventName === "execution.complete",
    );
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.data).toMatchObject({
      payload: {
        planId: "plan-1",
        status: "completed",
        completedSteps: 1,
        failedSteps: 0,
        skippedSteps: 0,
      },
    });
  });

  it("publishes events synchronously without awaiting (fire-and-forget pattern)", async () => {
    // Bus.publish is synchronous (returns void), and the orchestrator
    // calls it with `void Bus.publish(...)` to signal fire-and-forget intent.
    // This test verifies that events are published and execution completes.
    responseQueue.push("step output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1")]);
    const result = await TeamOrchestrator.execute(plan, makeConfig());

    // Execution completed successfully
    expect(result.status).toBe("completed");
    // Events were published during execution
    expect(publishedEvents.length).toBeGreaterThan(0);
    // Verify specific event ordering: plan.created should come first
    expect(publishedEvents[0]?.eventName).toBe("plan.created");
  });
});
