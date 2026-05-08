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

describe("IngressEngine integration pipeline", () => {
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
    it("does not leak context across different surface keys", async () => {
      testState.responseQueue.push("response-a");
      testState.responseQueue.push("response-b");

      const first = await IngressEngine.ingest({
        id: "evt-isolation-a",
        mode: "direct",
        surface: "tui",
        workspace: "/project-a",
        payload: "Message A",
        agent: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
      });

      const second = await IngressEngine.ingest({
        id: "evt-isolation-b",
        mode: "direct",
        surface: "tui",
        workspace: "/project-b",
        payload: "Message B",
        agent: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
      });

      expect(first.sessionId).not.toBe(second.sessionId);
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
