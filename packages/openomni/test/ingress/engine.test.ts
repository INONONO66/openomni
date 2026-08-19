import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Ingress, type Gateway } from "@openomni/protocol";
import { Session, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import {
  defaultRunFn,
  mockModelsGet,
  mockProviderFromModelsDevModel,
  resetTestState,
  testState,
} from "./_llm-mock";

// #707 stage 2: the brain engine's external entry is `deliver(Gateway.Deliver)`
// — the gateway router's injected port. These tests hand-build Deliver
// payloads (openomni tests never import @openomni/channels); routing,
// channel-grant, and authority behaviors live in the router's own tests.

type BrainEngineModule = typeof import("../../src/ingress/engine");
type BrainEngine = import("../../src/ingress/engine").BrainEngine;
type BrainEngineDeps = import("../../src/ingress/engine").BrainEngineDeps;

let createBrainEngine: BrainEngineModule["createBrainEngine"];
let ResidentRuntime: typeof import("../../src/resident/runtime").ResidentRuntime;
let engine: BrainEngine;

beforeAll(async () => {
  ({ createBrainEngine } = await import("../../src/ingress/engine"));
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
  engine = makeEngine();
});

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

function makeEngine(overrides: BrainEngineDeps = {}): BrainEngine {
  return createBrainEngine({
    residentRuntime: testResidentRuntime(),
    coordinator: testCoordinator(),
    externalAgentResolver: async () => ({ model: { provider: "test", id: "test-model" } }),
    ...overrides,
  });
}

/**
 * A hand-built Gateway.Deliver in the shape the router records for a
 * surface_default admission: the routed event residue plus the recorded
 * route.decided fact. Must parse under Gateway.Deliver at the seam.
 */
function makeDeliver(
  options: { id?: string; sessionId?: string; target?: Ingress.Target; payload?: string } = {},
): Gateway.Deliver {
  const id = options.id ?? crypto.randomUUID();
  const payload = options.payload ?? "hello";
  const target = options.target;
  const targetLabel =
    target === undefined || target.kind === "resident"
      ? "resident"
      : target.sessionId !== undefined
        ? `worker-session:${target.sessionId}`
        : "worker";
  return {
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    message: {
      messageId: id,
      traceId: "trace-test",
      surfaceKey: "tui:/repo:resident",
      text: payload,
    },
    actorContext: {
      actorId: "act_owner",
      trustTier: "owner",
      inboundTreatment: "full_access",
      origin: { surface: "tui", externalId: "owner-external-id" },
    },
    event: {
      id,
      traceId: "trace-test",
      surface: "tui",
      workspace: "/repo",
      channel: "resident",
      mode: "direct",
      payload,
      ...(target === undefined ? {} : { target }),
      meta: { actor: { role: "user", trustTier: "owner" } },
    },
    decision: {
      traceId: "trace-test",
      time: Date.now(),
      inboundId: id,
      surface: "tui",
      mode: "direct",
      stage: "surface_default",
      outcome: "route",
      target: targetLabel,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      actorId: "act_owner",
      trustTier: "owner",
      inboundTreatment: "full_access",
      reason: "Inbound message routed to the surface session",
      factsUsed: ["wait:none", `target:${targetLabel}`],
    },
  };
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

describe("BrainEngine deliver", () => {
  it("executes a routed resident delivery through the resident runtime", async () => {
    testState.responseQueue.push("direct response");

    const result = await engine.deliver(makeDeliver({ sessionId: crypto.randomUUID() }));

    expect(result.mode).toBe("direct");
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.result.output).toBe("direct response");
    expect(result.result.finishReason).toBe("stop");
  });

  it("emits canonical target keys for worker deliveries and dispatches the coordinator", async () => {
    testState.responseQueue.push("direct response");
    const workerSession = Session.create({
      traceId: "trace-test",
      title: "worker target key test",
      model: { providerID: "test", modelID: "fixture" },
    });
    const received: Array<{ target?: string; traceId?: string }> = [];
    const unsubscribe = Bus.subscribe(Ingress.Events.Received, (event) => {
      received.push(event);
    });

    let result: Ingress.IngressResult;
    try {
      result = await engine.deliver(
        makeDeliver({ target: { kind: "worker", sessionId: workerSession.id } }),
      );
    } finally {
      unsubscribe();
    }

    expect(received.at(-1)?.target).toBe(`worker-session:${workerSession.id}`);
    // D11 keystone pin (#654 review): deliver INHERITS the event's trace —
    // reverting the engine to a fresh mint must fail here, not stay green.
    expect(received.at(-1)?.traceId).toBe("trace-test");
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.result.output).toBe("direct response");
  });

  it("rejects a worker-target delivery without a coordinator", async () => {
    engine = makeEngine({ coordinator: undefined });

    const error = await catchError(
      engine.deliver(makeDeliver({ target: { kind: "worker", sessionId: "worker-sess-1" } })),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("coordinator is required for worker target");
  });

  it("rejects a resident delivery without a routed sessionId", async () => {
    const error = await catchError(engine.deliver(makeDeliver()));

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain("resident delivery without a routed sessionId");
  });

  it("rejects delivery when no external agent resolver is configured", async () => {
    engine = makeEngine({ externalAgentResolver: undefined });

    const error = await catchError(engine.deliver(makeDeliver({ sessionId: crypto.randomUUID() })));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("external agent resolver not configured");
  });

  it("rejects a malformed delivery at the seam", async () => {
    const { decision: _decision, ...withoutDecision } = makeDeliver({
      sessionId: crypto.randomUUID(),
    });

    const error = await catchError(engine.deliver(withoutDecision));

    expect(error).toBeDefined();
  });

  it("reuses one session row across deliveries with the same routed sessionId", async () => {
    testState.responseQueue.push("first response");
    testState.responseQueue.push("second response");
    const sessionId = crypto.randomUUID();
    const resolved: Array<{ sessionId: string; isNew: boolean }> = [];
    const unsubscribe = Bus.subscribe(Ingress.Events.SessionResolved, (event) => {
      resolved.push(event);
    });

    let first: Ingress.IngressResult;
    let second: Ingress.IngressResult;
    try {
      first = await engine.deliver(makeDeliver({ sessionId }));
      second = await engine.deliver(makeDeliver({ sessionId }));
    } finally {
      unsubscribe();
    }

    if (first.kind === "dropped" || second.kind === "dropped") throw new Error("shape");
    expect(first.sessionId).toBe(sessionId);
    expect(second.sessionId).toBe(sessionId);
    // Lazy materialization is idempotent: one row, created exactly once.
    expect(Session.list().map((session) => session.id)).toEqual([sessionId]);
    expect(resolved.map((entry) => entry.isNew)).toEqual([true, false]);
  });

  it("keeps deliveries with different routed sessionIds in different rows", async () => {
    testState.responseQueue.push("first response");
    testState.responseQueue.push("second response");
    const sessionA = crypto.randomUUID();
    const sessionB = crypto.randomUUID();

    const first = await engine.deliver(makeDeliver({ sessionId: sessionA }));
    const second = await engine.deliver(makeDeliver({ sessionId: sessionB }));

    if (first.kind === "dropped" || second.kind === "dropped") throw new Error("shape");
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(Session.list()).toHaveLength(2);
  });
});
