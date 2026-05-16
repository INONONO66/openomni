import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { PolicyDecision, PolicyRegistration } from "@openomni/agent";
import {
  Ingress as IngressNamespace,
  PolicyDecision as ProtocolPolicyDecision,
  type Ingress,
} from "@openomni/protocol";
import { Storage } from "@openomni/session";
import {
  defaultRunFn,
  mockModelsGet,
  mockProviderFromModelsDevModel,
  resetTestState,
  testState,
} from "./_llm-mock";

let IngressEngine: typeof import("../../src/ingress/engine").IngressEngine;
let ResidentRuntime: typeof import("../../src/resident/runtime").ResidentRuntime;

beforeAll(async () => {
  ({ IngressEngine } = await import("../../src/ingress/engine"));
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
  IngressEngine.reset();
  Storage.initialize({ dbPath: ":memory:" });
  installResidentRuntime();
  installCoordinator();
});

function installResidentRuntime() {
  IngressEngine.setResidentRuntime(
    ResidentRuntime.create({
      runAgent: async (_config, input) => {
        testState.llmInputs.push(input);
        return { text: testState.responseQueue.shift() ?? "{}", finishReason: "stop" };
      },
    }),
  );
}

function installCoordinator() {
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
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
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

    const result = await IngressEngine.ingest(event);

    expect(result.mode).toBe("direct");
    expect(result.result.output).toBe("direct response");
    expect(result.result.finishReason).toBe("stop");
  });

  it("ingest() with invalid event throws", async () => {
    const error = await catchError(
      IngressEngine.ingest({
        id: "invalid-1",
        surface: "tui",
        payload: "hello",
      } as unknown as Ingress.InboundEvent),
    );

    expect(error).toBeDefined();
  });

  it("rejects missing coordinator through ingress middleware", async () => {
    const decisions: PolicyDecision[] = [];
    IngressEngine.clearCoordinator();
    IngressEngine.setPolicyDecisionObserver((decision) => {
      decisions.push(decision);
    });

    const error = await catchError(
      IngressEngine.ingest({
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
    IngressEngine.setCoordinator({
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
    });

    const error = await catchError(
      IngressEngine.ingest({
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
    IngressEngine.setCoordinator({
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
    });

    IngressEngine.registerIngressPolicy({
      name: "test:deny-inbound",
      timing: "inbound.receive",
      priority: 0,
      fn: () =>
        ProtocolPolicyDecision.deny({
          policyId: "test:deny-inbound",
          reasonCodes: ["inbound denied by policy"],
          effects: [{ type: "run.abort", reason: "inbound denied by policy" }],
        }),
    });

    const error = await catchError(
      IngressEngine.ingest({
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
    IngressEngine.setCoordinator({
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
    });

    IngressEngine.registerIngressPolicy({
      name: "test:retry-inbound",
      timing: "inbound.receive",
      priority: 0,
      fn: () =>
        ProtocolPolicyDecision.pending({
          policyId: "test:retry-inbound",
          reasonCodes: ["approval required at inbound.receive"],
          effects: [{ type: "run.abort", reason: "approval required at inbound.receive" }],
        }),
    });

    const error = await catchError(
      IngressEngine.ingest({
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

    const first = await IngressEngine.ingest(eventA);
    const second = await IngressEngine.ingest(eventB);

    expect(first.sessionId).toBe(second.sessionId);
  });

  it("reset() clears session mapping state", async () => {
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

    const first = await IngressEngine.ingest(event);
    IngressEngine.reset();
    Storage.initialize({ dbPath: ":memory:" });
    installResidentRuntime();
    installCoordinator();

    const second = await IngressEngine.ingest({
      ...event,
      id: "event-reset-2",
      payload: "After reset",
    });

    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it("ingest() with unknown mode throws UNKNOWN_INGRESS_MODE error", async () => {
    const event: Ingress.InboundEvent = {
      id: "event-unknown-1",
      surface: "tui",
      workspace: "/repo",
      mode: "unknown-mode",
      payload: "test",
      meta: { actor: { role: "user" } },
      agent: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    } as unknown as Ingress.InboundEvent;

    const schema = IngressNamespace.InboundEventSchema as unknown as {
      safeParse: (input: unknown) => unknown;
    };
    const originalSafeParse = schema.safeParse;
    schema.safeParse = () => ({ success: true, data: event });

    try {
      let caughtError: unknown;
      try {
        await IngressEngine.ingest(event);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toContain("unknown ingress mode");
    } finally {
      schema.safeParse = originalSafeParse;
    }
  });

  describe("inbound.receive policy dispatch", () => {
    function makeEvent(overrides?: Partial<Ingress.InboundEvent>): Ingress.InboundEvent {
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

    function abortPolicy(reason: string): PolicyRegistration {
      return {
        name: "test:ingress-abort",
        timing: "inbound.receive",
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

    function continuePolicy(): PolicyRegistration {
      return {
        name: "test:ingress-continue",
        timing: "inbound.receive",
        priority: 0,
        fn: () => ProtocolPolicyDecision.allow({ policyId: "test.continue", reasonCodes: ["ok"] }),
      };
    }

    it("aborts ingest when inbound.receive policy returns abort", async () => {
      IngressEngine.registerIngressPolicy(abortPolicy("rate limit exceeded"));

      const error = await catchError(IngressEngine.ingest(makeEvent()));

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("rate limit exceeded");
    });

    it("proceeds normally when inbound.receive policy returns continue", async () => {
      testState.responseQueue.push("policy-ok response");
      IngressEngine.registerIngressPolicy(continuePolicy());

      const result = await IngressEngine.ingest(makeEvent());

      expect(result.mode).toBe("direct");
      expect(result.result.output).toBe("policy-ok response");
    });

    it("records inbound.receive decision through observer", async () => {
      const decisions: PolicyDecision[] = [];
      IngressEngine.setPolicyDecisionObserver((d) => {
        decisions.push(d);
      });
      IngressEngine.registerIngressPolicy(abortPolicy("blocked"));

      await catchError(IngressEngine.ingest(makeEvent()));

      const ingressDecision = decisions.find((d) => d.policyId === "test.abort");
      expect(ingressDecision).toBeDefined();
      expect(ingressDecision?.verdict).toBe("deny");
      if (!ingressDecision) throw new Error("expected ingress decision");
      expect(ProtocolPolicyDecision.reason(ingressDecision)).toBe("blocked");
    });

    it("provides surface and actor labels to policy context", async () => {
      let capturedLabels: unknown;
      IngressEngine.registerIngressPolicy({
        name: "test:label-capture",
        timing: "inbound.receive",
        priority: 0,
        fn: (ctx) => {
          capturedLabels = ctx.labels;
          return ProtocolPolicyDecision.allow({
            policyId: "test.labels",
            reasonCodes: ["captured"],
          });
        },
      });
      testState.responseQueue.push("ok");

      await IngressEngine.ingest(
        makeEvent({ surface: "slack", meta: { actor: { role: "user" } } }),
      );

      expect(capturedLabels).toEqual([
        { value: "surface.slack", source: "system" },
        { value: "target.resident", source: "system" },
        { value: "actor.user", source: "system" },
      ]);
    });

    it("skips dispatch when no ingress policies registered", async () => {
      testState.responseQueue.push("no-policy response");

      const result = await IngressEngine.ingest(makeEvent());

      expect(result.mode).toBe("direct");
      expect(result.result.output).toBe("no-policy response");
    });
  });
});
