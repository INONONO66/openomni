import { beforeEach, describe, expect, test } from "bun:test";
import { createBrainEngine } from "@openomni/openomni";
import { createGatewayRouter, type GatewayRouter } from "@openomni/channels";
import type { Execution, Gateway } from "@openomni/protocol";
import { ChannelGrantStore, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";

type CoordinatorLike = {
  dispatch(sessionId: string, request: Execution.Request): Promise<Execution.Result>;
};

function makeDirectEvent(): Gateway.DeliveredEvent {
  return {
    id: crypto.randomUUID(),
    traceId: "trace-test",
    surface: "test",
    mode: "direct",
    payload: "hello",
    target: { kind: "worker" },
    meta: { actor: { role: "user" }, target: { kind: "worker" } },
  };
}

// #707 stage 2: the external pipeline is the gateway router composed over the
// brain's Deliver consumer; the AgentDef the old fixture embedded now comes
// from the injected external agent resolver.
function makeEngine(coordinator?: CoordinatorLike): GatewayRouter {
  const brain = createBrainEngine({
    ...(coordinator === undefined ? {} : { coordinator }),
    externalAgentResolver: async () => ({
      model: { provider: "anthropic", id: "claude-3-5-sonnet-20241022" },
      tools: [],
    }),
  });
  return createGatewayRouter({ sink: Bus.publish, deliver: brain.deliver });
}

beforeEach(() => {
  Storage.reset();
  Bus.reset();
  Storage.initialize({ dbPath: ":memory:" });
  ChannelGrantStore.put({
    id: "grant-test",
    surface: "test",
    kind: "trusted_channel",
    defaultTier: "owner",
    createdBy: "act_owner",
  });
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

    const engine = makeEngine(mockCoordinator);

    const result = await engine.ingest(makeDirectEvent());

    expect(result.mode).toBe("direct");
    if (result.mode !== "direct") throw new Error("expected direct result");
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.result.output).toBe("mock response");
  });
});

describe("no coordinator — error required", () => {
  test("throws when coordinator is not set", () => {
    return expect(makeEngine().ingest(makeDirectEvent())).rejects.toThrow(
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

    const engine = makeEngine(failingCoordinator);

    return expect(engine.ingest(makeDirectEvent())).rejects.toThrow("worker unreachable");
  });

  test("throws when coordinator returns non-succeeded status", () => {
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

    const engine = makeEngine(failingCoordinator);

    return expect(engine.ingest(makeDirectEvent())).rejects.toThrow("Coordinator dispatch failed");
  });
});
