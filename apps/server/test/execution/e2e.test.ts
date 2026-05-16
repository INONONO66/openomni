import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IngressEngine } from "@openomni/openomni";
import type { Execution, Ingress } from "@openomni/protocol";

type CoordinatorLike = {
  dispatch(sessionId: string, request: Execution.Request): Promise<Execution.Result>;
};

function makeDirectEvent(): Ingress.DirectEvent {
  return {
    id: crypto.randomUUID(),
    surface: "test",
    mode: "direct",
    payload: "hello",
    target: { kind: "new-worker" },
    meta: { actor: { role: "user" }, target: { kind: "new-worker" } },
    agent: {
      model: { provider: "anthropic", id: "claude-3-5-sonnet-20241022" },
      tools: [],
    },
  };
}

beforeEach(() => {
  IngressEngine.reset();
  IngressEngine.setCoordinator(undefined);
});

afterEach(() => {
  IngressEngine.setCoordinator(undefined);
});

describe("coordinator dispatch path — direct mode", () => {
  test("routes request through coordinator and returns its output", async () => {
    const mockCoordinator: CoordinatorLike = {
      async dispatch(_sessionId: string, request: Execution.Request): Promise<Execution.Result> {
        return {
          runId: request.runId,
          sessionId: request.sessionId,
          status: "succeeded",
          output: "mock response",
          finishReason: "stop",
        };
      },
    };

    IngressEngine.setCoordinator(mockCoordinator);

    const result = await IngressEngine.ingest(makeDirectEvent());

    expect(result.mode).toBe("direct");
    if (result.mode !== "direct") throw new Error("expected direct result");
    expect(result.result.output).toBe("mock response");
  });
});

describe("no coordinator — error required", () => {
  test("throws when coordinator is not set", async () => {
    await expect(IngressEngine.ingest(makeDirectEvent())).rejects.toThrow(
      "coordinator is required",
    );
  });
});

describe("coordinator failure — error propagated", () => {
  test("throws when coordinator dispatch rejects", async () => {
    const failingCoordinator: CoordinatorLike = {
      async dispatch(): Promise<Execution.Result> {
        throw new Error("worker unreachable");
      },
    };

    IngressEngine.setCoordinator(failingCoordinator);

    await expect(IngressEngine.ingest(makeDirectEvent())).rejects.toThrow("worker unreachable");
  });

  test("throws when coordinator returns non-succeeded status", async () => {
    const failingCoordinator: CoordinatorLike = {
      async dispatch(_sessionId: string, request: Execution.Request): Promise<Execution.Result> {
        return {
          runId: request.runId,
          sessionId: request.sessionId,
          status: "failed",
          error: "worker crashed",
        };
      },
    };

    IngressEngine.setCoordinator(failingCoordinator);

    await expect(IngressEngine.ingest(makeDirectEvent())).rejects.toThrow(
      "Coordinator dispatch failed",
    );
  });
});
