import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Ingress } from "@openomni/protocol";
import { Ingress as IngressNamespace } from "@openomni/protocol";
import { Storage } from "@openomni/session";
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

function enqueuePlan(planId?: string): void {
  testState.responseQueue.push(JSON.stringify({ planId: planId ?? crypto.randomUUID() }));
}

describe("IngressEngine", () => {
  it("ingest() with plan mode returns plan result", async () => {
    enqueuePlan();

    const event: Ingress.InboundEvent = {
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
    expect(result.result.planId).toBeString();
  });

  it("ingest() with direct mode returns direct result", async () => {
    testState.responseQueue.push("direct response");

    const event: Ingress.InboundEvent = {
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
      } as unknown as Ingress.InboundEvent),
    ).rejects.toThrow();
  });

  it("reuses session for same surface key across calls", async () => {
    enqueuePlan();
    enqueuePlan();

    const eventA: Ingress.InboundEvent = {
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

    const eventB: Ingress.InboundEvent = {
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
    enqueuePlan();
    enqueuePlan();

    const event: Ingress.InboundEvent = {
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

    const second = await IngressEngine.ingest({
      ...event,
      id: "event-reset-2",
      payload: "Plan after reset",
    });

    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it("ingest() with unknown mode throws UNKNOWN_INGRESS_MODE error", async () => {
    // Create an event with an unknown mode
    const event: Ingress.InboundEvent = {
      id: "event-unknown-1",
      surface: "tui",
      workspace: "/repo",
      mode: "unknown-mode",
      payload: "test",
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    } as unknown as Ingress.InboundEvent;

    // Mock the schema parse to allow the unknown mode through so we can test the switch default case
    const originalParse = IngressNamespace.InboundEventSchema.parse;
    IngressNamespace.InboundEventSchema.parse = (input: unknown) => input as Ingress.InboundEvent;

    try {
      let caughtError: unknown;
      try {
        await IngressEngine.ingest(event);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toContain("unknown ingress mode");
      expect((caughtError as Error).message).toContain("unknown-mode");
    } finally {
      // Restore original parse behavior
      IngressNamespace.InboundEventSchema.parse = originalParse;
    }
  });
});
