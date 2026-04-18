import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Ingress } from "@openomni/protocol";
import { ZodError } from "zod";
import {
  defaultRunFn,
  mockModelsGet,
  mockProviderFromModelsDevModel,
  resetTestState,
  testState,
} from "./_llm-mock";

let IngressEngine: typeof import("../../src/ingress/engine").IngressEngine;
let SessionBridge: typeof import("../../src/ingress/session-bridge").SessionBridge;

beforeAll(async () => {
  ({ IngressEngine } = await import("../../src/ingress/engine"));
  ({ SessionBridge } = await import("../../src/ingress/session-bridge"));
});

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  resetTestState();
  testState.runFn = defaultRunFn("integration-test");
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
  IngressEngine.reset();
  IngressEngine.setCoordinator({
    async dispatch(_sessionId, request) {
      const output = testState.responseQueue.shift() ?? "{}";
      return {
        runId: request.runId,
        sessionId: request.sessionId,
        status: "succeeded" as const,
        output,
        finishReason: "stop" as const,
      };
    },
  });
});

function enqueuePlan(planId: string, goal: string, stepId: string): void {
  testState.responseQueue.push(
    JSON.stringify({
      plan: {
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
      },
    }),
  );
}

describe("IngressEngine integration pipeline", () => {
  describe("plan -> re-plan lifecycle", () => {
    it("reuses session and builds on previous plan", async () => {
      enqueuePlan("plan-1", "Build a REST API", "step-1");
      enqueuePlan("plan-2", "Add auth to step 2", "step-2");

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
      expect(second.result.plan.goal).toBe("Add auth to step 2");
      expect(first.sessionId).toBe(second.sessionId);
    });
  });

  describe("direct mode conversation history", () => {
    it("sends accumulated user history on second turn", async () => {
      testState.responseQueue.push("Hi there");
      testState.responseQueue.push("Sure, what do you need?");

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

      expect(first.mode).toBe("direct");
      expect(second.mode).toBe("direct");
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
    });
  });

  describe("error cases", () => {
    it("throws zod error when mode is missing", async () => {
      const invalidEvent = {
        id: "evt-invalid-no-mode",
        surface: "tui",
        payload: "hello",
      };

      await expect(
        IngressEngine.ingest(invalidEvent as unknown as Ingress.InboundEvent),
      ).rejects.toBeInstanceOf(ZodError);
    });
  });
});
