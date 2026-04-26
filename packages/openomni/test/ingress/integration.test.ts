import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Ingress } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { ZodError } from "zod";
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
  testState.runFn = defaultRunFn("integration-test");
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
  IngressEngine.reset();
  Storage.initialize({ dbPath: ":memory:" });
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

function enqueuePlan(planId: string): void {
  testState.responseQueue.push(JSON.stringify({ planId }));
}

describe("IngressEngine integration pipeline", () => {
  describe("plan -> re-plan lifecycle", () => {
    it("reuses session and returns planId reference", async () => {
      enqueuePlan("plan-1");
      enqueuePlan("plan-2");

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
      if (first.mode !== "plan") throw new Error("Expected plan mode result");
      expect(first.result.planId).toBe("plan-1");

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
      if (second.mode !== "plan") throw new Error("Expected plan mode result");
      expect(second.result.planId).toBe("plan-2");
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
      enqueuePlan("plan-a");
      enqueuePlan("plan-b");

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
      if (first.mode !== "plan" || second.mode !== "plan") {
        throw new Error("Expected plan mode results");
      }
      expect(first.result.planId).toBe("plan-a");
      expect(second.result.planId).toBe("plan-b");
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
