import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { InboundEvent } from "@openomni/protocol";
import {
  defaultRunFn,
  mockModelsGet,
  mockProviderFromModelsDevModel,
  resetTestState,
  testState,
} from "./_llm-mock";

let IngressEngine: typeof import("../../src/ingress/engine").IngressEngine;

beforeAll(async () => {
  ({ IngressEngine } = await import("../../src/ingress/engine"));
});

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  resetTestState();
  testState.runFn = defaultRunFn("engine-test");
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
  IngressEngine.reset();
});

function enqueuePlan(goal: string): void {
  testState.responseQueue.push(
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

  it("ingest() with direct mode returns direct result", async () => {
    testState.responseQueue.push("direct response");

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
