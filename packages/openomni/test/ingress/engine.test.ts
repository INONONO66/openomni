import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  IngressEvent,
  PolicyDecision as ProtocolPolicyDecision,
  type Ingress,
  type Policy,
} from "@openomni/protocol";
import type { IngressPolicyGate } from "../../src/ingress/policy-gate";
import { Bus, ChannelGrantStore, Session, Storage } from "@openomni/session";
import {
  defaultRunFn,
  mockModelsGet,
  mockProviderFromModelsDevModel,
  resetTestState,
  testState,
} from "./_llm-mock";

type IngressEngineModule = typeof import("../../src/ingress/engine");
type IngressEngine = import("../../src/ingress/engine").IngressEngine;
type IngressEngineDeps = import("../../src/ingress/engine").IngressEngineDeps;

let createIngressEngine: IngressEngineModule["createIngressEngine"];
let ResidentRuntime: typeof import("../../src/resident/runtime").ResidentRuntime;
let engine: IngressEngine;

beforeAll(async () => {
  ({ createIngressEngine } = await import("../../src/ingress/engine"));
  ({ ResidentRuntime } = await import("../../src/resident/runtime"));
});

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  resetTestState();
  testState.runFn = defaultRunFn("engine-test");
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
  Storage.reset();
  Bus.reset();
  Storage.initialize({ dbPath: ":memory:" });
  installChannelGrants();
  engine = makeEngine();
});

function installChannelGrants() {
  for (const surface of ["slack", "tui", "internal"]) {
    ChannelGrantStore.put({
      id: `grant-${surface}`,
      surface,
      kind: "trusted_channel",
      ...(surface === "internal" ? {} : { defaultTier: "owner" }),
      createdBy: "act_owner",
    });
  }
}

function testResidentRuntime() {
  return ResidentRuntime.create({
    runAgent: async (_config, input) => {
      testState.llmInputs.push(input);
      return { text: testState.responseQueue.shift() ?? "{}", finishReason: "stop" };
    },
  });
}

function testCoordinator() {
  return {
    async dispatch(
      _sessionId: string,
      request: { runId: string; sessionId: string },
    ): Promise<{
      runId: string;
      sessionId: string;
      status: "succeeded";
      output: string;
      finishReason: "stop";
    }> {
      const output = testState.responseQueue.shift() ?? "{}";
      return {
        runId: request.runId,
        sessionId: request.sessionId,
        status: "succeeded" as const,
        output,
        finishReason: "stop" as const,
      };
    },
  };
}

function makeEngine(overrides: IngressEngineDeps = {}): IngressEngine {
  return createIngressEngine({
    residentRuntime: testResidentRuntime(),
    coordinator: testCoordinator(),
    ...overrides,
  });
}

async function catchError(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
}

describe("IngressEngine", () => {
  it("ingest() with direct mode returns direct result", async () => {
    testState.responseQueue.push("direct response");

    const event: Ingress.InboundEvent = {
      id: "event-direct-1",
      surface: "slack",
      workspace: "team-a",
      channel: "C1",
      mode: "direct",
      payload: "hello",
      meta: { actor: { role: "user" } },
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };

    const result = await engine.ingest(event);

    expect(result.mode).toBe("direct");
    expect(result.result.output).toBe("direct response");
    expect(result.result.finishReason).toBe("stop");
  });

  it("emits canonical target keys for worker ingress events", async () => {
    testState.responseQueue.push("worker response");
    const workerSession = Session.create({
      title: "worker target key test",
      model: { providerID: "test", modelID: "fixture" },
    });
    const received: Array<{ target?: string }> = [];
    const unsubscribe = Bus.subscribe(IngressEvent.Received, (event) => {
      received.push(event);
    });

    try {
      await engine.ingest({
        id: "event-worker-target-key-1",
        surface: "slack",
        workspace: "team-a",
        channel: "C1",
        mode: "direct",
        payload: "hello",
        target: { kind: "worker", sessionId: workerSession.id },
        meta: { actor: { role: "user" } },
        agent: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
      });
    } finally {
      unsubscribe();
    }

    expect(received.at(-1)?.target).toBe(`worker-session:${workerSession.id}`);
  });

  it("ingest() with invalid event throws", async () => {
    const error = await catchError(
      engine.ingest({
        id: "invalid-1",
        surface: "tui",
        payload: "hello",
      }),
    );

    expect(error).toBeDefined();
  });

  it("rejects missing coordinator through ingress middleware", async () => {
    const decisions: Policy.PolicyDecision[] = [];
    engine = makeEngine({
      coordinator: undefined,
      onPolicyDecision: (decision) => {
        decisions.push(decision);
      },
    });

    const error = await catchError(
      engine.ingest({
        id: "event-no-coordinator-1",
        surface: "tui",
        workspace: "/repo",
        mode: "direct",
        target: { kind: "worker" },
        payload: "hello",
        meta: { actor: { role: "user" }, target: { kind: "worker", sessionId: "worker-sess-1" } },
        agent: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("coordinator is required for worker target");
    expect(decisions).toContainEqual(
      expect.objectContaining({
        policyId: "ingress.coordinator",
        verdict: "deny",
        reasonCodes: ["coordinator is required for worker target"],
      }),
    );
  });

  it("rejects unauthorized top-level actors before dispatch", async () => {
    let dispatchCalled = false;
    engine = makeEngine({
      coordinator: {
        async dispatch(_sessionId, request) {
          dispatchCalled = true;
          return {
            runId: request.runId,
            sessionId: request.sessionId,
            status: "succeeded" as const,
            output: "should not dispatch",
            finishReason: "stop" as const,
          };
        },
      },
    });

    const error = await catchError(
      engine.ingest({
        id: "event-unauthorized-1",
        surface: "internal",
        workspace: "/repo",
        mode: "direct",
        payload: "spawn top-level work",
        meta: { actor: { role: "sub_persona", trusted: false } },
        agent: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "actor is not authorized to create top-level inbound work",
    );
    expect(dispatchCalled).toBe(false);
  });

  it("treats inbound.receive deny verdict as terminal before dispatch", async () => {
    let dispatchCalled = false;
    engine = makeEngine({
      coordinator: {
        async dispatch(_sessionId, request) {
          dispatchCalled = true;
          return {
            runId: request.runId,
            sessionId: request.sessionId,
            status: "succeeded" as const,
            output: "should not dispatch",
            finishReason: "stop" as const,
          };
        },
      },
      policies: [
        {
          name: "test:deny-inbound",
          gate: "inbound",
          priority: 0,
          fn: () =>
            ProtocolPolicyDecision.deny({
              policyId: "test:deny-inbound",
              reasonCodes: ["inbound denied by policy"],
              effects: [{ type: "run.abort", reason: "inbound denied by policy" }],
            }),
        },
      ],
    });

    const error = await catchError(
      engine.ingest({
        id: "event-denied-inbound-1",
        surface: "tui",
        workspace: "/repo",
        mode: "direct",
        payload: "hello",
        meta: { actor: { role: "user" } },
        agent: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("inbound denied by policy");
    expect(dispatchCalled).toBe(false);
  });

  it("treats inbound.receive pending verdict as terminal", async () => {
    let dispatchCalled = false;
    engine = makeEngine({
      coordinator: {
        async dispatch(_sessionId, request) {
          dispatchCalled = true;
          return {
            runId: request.runId,
            sessionId: request.sessionId,
            status: "succeeded" as const,
            output: "should not dispatch",
            finishReason: "stop" as const,
          };
        },
      },
      policies: [
        {
          name: "test:retry-inbound",
          gate: "inbound",
          priority: 0,
          fn: () =>
            ProtocolPolicyDecision.pending({
              policyId: "test:retry-inbound",
              reasonCodes: ["approval required at inbound.receive"],
              effects: [{ type: "run.abort", reason: "approval required at inbound.receive" }],
            }),
        },
      ],
    });

    const error = await catchError(
      engine.ingest({
        id: "event-retry-inbound-1",
        surface: "tui",
        workspace: "/repo",
        mode: "direct",
        payload: "hello",
        meta: { actor: { role: "user" } },
        agent: {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("approval required at inbound.receive");
    expect(dispatchCalled).toBe(false);
  });

  it("reuses session for same surface key across calls", async () => {
    testState.responseQueue.push("first response");
    testState.responseQueue.push("second response");

    const eventA: Ingress.InboundEvent = {
      id: "event-reuse-1",
      surface: "tui",
      workspace: "/repo",
      channel: "resident",
      mode: "direct",
      payload: "First message",
      meta: { actor: { role: "user" } },
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };

    const eventB: Ingress.InboundEvent = {
      id: "event-reuse-2",
      surface: "tui",
      workspace: "/repo",
      channel: "resident",
      mode: "direct",
      payload: "Second message",
      meta: { actor: { role: "user" } },
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };

    const first = await engine.ingest(eventA);
    const second = await engine.ingest(eventB);

    expect(first.sessionId).toBe(second.sessionId);
  });

  it("storage reset clears session mapping state", async () => {
    testState.responseQueue.push("before reset");
    testState.responseQueue.push("after reset");

    const event: Ingress.InboundEvent = {
      id: "event-reset-1",
      surface: "tui",
      workspace: "/repo",
      mode: "direct",
      payload: "Before reset",
      meta: { actor: { role: "user" } },
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };

    const first = await engine.ingest(event);
    Storage.reset();
    Bus.reset();
    Storage.initialize({ dbPath: ":memory:" });
    installChannelGrants();
    engine = makeEngine();

    const second = await engine.ingest({
      ...event,
      id: "event-reset-2",
      payload: "After reset",
    });

    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it("ingest() with unknown mode fails external ingress schema validation", async () => {
    const event = {
      id: "event-unknown-1",
      surface: "tui",
      workspace: "/repo",
      mode: "unknown-mode",
      payload: "test",
      meta: { actor: { role: "user" } },
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    };

    let caughtError: Error | undefined;
    try {
      await engine.ingest(event);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError?.message).toContain("invalid_literal");
  });

  describe("inbound.receive policy dispatch", () => {
    function makeEvent(overrides?: Partial<Ingress.DirectEvent>): Ingress.DirectEvent {
      return {
        id: "event-policy-1",
        surface: "tui",
        workspace: "/repo",
        mode: "direct",
        payload: "hello",
        meta: { actor: { role: "user" } },
        agent: { model: { provider: "anthropic", id: "claude-3-haiku-20240307" } },
        ...overrides,
      };
    }

    function abortPolicy(reason: string): IngressPolicyGate.IngressPolicy {
      return {
        name: "test:ingress-abort",
        gate: "inbound",
        priority: 0,
        failPolicy: "fail-closed",
        fn: () =>
          ProtocolPolicyDecision.deny({
            policyId: "test.abort",
            reasonCodes: [reason],
            effects: [{ type: "run.abort", reason }],
          }),
      };
    }

    function continuePolicy(): IngressPolicyGate.IngressPolicy {
      return {
        name: "test:ingress-continue",
        gate: "inbound",
        priority: 0,
        fn: () => ProtocolPolicyDecision.allow({ policyId: "test.continue", reasonCodes: ["ok"] }),
      };
    }

    it("aborts ingest when inbound.receive policy returns abort", async () => {
      engine = makeEngine({ policies: [abortPolicy("rate limit exceeded")] });

      const error = await catchError(engine.ingest(makeEvent()));

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("rate limit exceeded");
    });

    it("proceeds normally when inbound.receive policy returns continue", async () => {
      testState.responseQueue.push("policy-ok response");
      engine = makeEngine({ policies: [continuePolicy()] });

      const result = await engine.ingest(makeEvent());

      expect(result.mode).toBe("direct");
      expect(result.result.output).toBe("policy-ok response");
    });

    it("records inbound.receive decision through observer", async () => {
      const decisions: Policy.PolicyDecision[] = [];
      engine = makeEngine({
        onPolicyDecision: (d) => {
          decisions.push(d);
        },
        policies: [abortPolicy("blocked")],
      });

      await catchError(engine.ingest(makeEvent()));

      const ingressDecision = decisions.find((d) => d.policyId === "test.abort");
      expect(ingressDecision).toBeDefined();
      expect(ingressDecision?.verdict).toBe("deny");
      if (!ingressDecision) throw new Error("expected ingress decision");
      expect(ProtocolPolicyDecision.reason(ingressDecision)).toBe("blocked");
    });

    it("provides surface and actor labels to policy context", async () => {
      let capturedLabels: unknown;
      engine = makeEngine({
        policies: [
          {
            name: "test:label-capture",
            gate: "inbound",
            priority: 0,
            fn: (ctx) => {
              if (ctx.gate === "inbound") capturedLabels = ctx.labels;
              return ProtocolPolicyDecision.allow({
                policyId: "test.labels",
                reasonCodes: ["captured"],
              });
            },
          },
        ],
      });
      testState.responseQueue.push("ok");

      await engine.ingest(makeEvent({ surface: "slack", meta: { actor: { role: "user" } } }));

      expect(capturedLabels).toEqual([
        { value: "surface.slack", source: "system" },
        { value: "target.resident", source: "system" },
        { value: "inbound.full_access", source: "system" },
        { value: "actor.user", source: "system" },
      ]);
    });

    it("skips dispatch when no ingress policies registered", async () => {
      testState.responseQueue.push("no-policy response");

      const result = await engine.ingest(makeEvent());

      expect(result.mode).toBe("direct");
      expect(result.result.output).toBe("no-policy response");
    });
  });
});
