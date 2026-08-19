import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Ingress } from "@openomni/protocol";
import { Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import {
  defaultRunFn,
  mockModelsGet,
  mockProviderFromModelsDevModel,
  resetTestState,
  testState,
} from "./_llm-mock";

type BrainEngine = import("../../src/ingress/engine").BrainEngine;
type BrainEngineDeps = import("../../src/ingress/engine").BrainEngineDeps;

let createBrainEngine: typeof import("../../src/ingress/engine")["createBrainEngine"];
let ResidentRuntime: typeof import("../../src/resident/runtime").ResidentRuntime;
let engine: BrainEngine;

beforeAll(async () => {
  ({ createBrainEngine } = await import("../../src/ingress/engine"));
  ({ ResidentRuntime } = await import("../../src/resident/runtime"));
});

afterAll(() => {
  mock.restore();
});

function makeEngine(overrides: BrainEngineDeps = {}): BrainEngine {
  return createBrainEngine({
    residentRuntime: ResidentRuntime.create({
      runAgent: async (_config, input) => {
        testState.llmInputs.push(input);
        return { text: testState.responseQueue.shift() ?? "{}", finishReason: "stop" };
      },
    }),
    ...overrides,
  });
}

beforeEach(() => {
  resetTestState();
  testState.runFn = defaultRunFn("engine-internal-test");
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
  Storage.reset();
  Bus.reset();
  Storage.initialize({ dbPath: ":memory:" });
  engine = makeEngine();
});

const mockAgentDef: Ingress.AgentDef = {
  model: { provider: "anthropic", id: "claude-3-5-sonnet" },
};

async function catchError(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
}

describe("ingestInternal", () => {
  it("publishes a routing decision before reporting a missing resolver", async () => {
    const event: Ingress.InternalEvent = {
      id: "t1",
      traceId: "trace-test",
      surface: "cron",
      mode: "internal",
      agentName: "dev",
      payload: "hello",
    };
    const decisions: unknown[] = [];
    const unsubscribe = Bus.observe((published, payload) => {
      if (published.name === "ingress.routing.decision") decisions.push(payload);
    });

    let error: Error | undefined;
    try {
      error = await catchError(engine.ingestInternal(event));
    } finally {
      unsubscribe();
    }

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("agent resolver not configured");
    expect(decisions).toHaveLength(1);
    expect(Ingress.Events.RoutingDecision.schema.parse(decisions[0])).toMatchObject({
      inboundId: event.id,
      stage: "surface_default",
      outcome: "route",
      actorId: "system:cron",
    });
  });

  it("publishes one schema-valid system decision before resident execution", async () => {
    const order: string[] = [];
    const decisions: unknown[] = [];
    const unsubscribe = Bus.observe((event, payload) => {
      if (event.name === "ingress.routing.decision") {
        order.push("publish");
        decisions.push(payload);
      }
    });
    engine = makeEngine({
      agentResolver: {
        resolve: async () => mockAgentDef,
      },
      residentRuntime: ResidentRuntime.create({
        runAgent: async () => {
          order.push("execute");
          return { text: "cron result", finishReason: "stop" };
        },
      }),
    });

    let result: Ingress.IngressResult;
    try {
      result = await engine.ingestInternal({
        id: "t2",
        traceId: "trace-test",
        surface: "cron",
        mode: "internal",
        agentName: "dev",
        payload: "run cron job",
      });
    } finally {
      unsubscribe();
    }

    expect(result.mode).toBe("internal");
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.sessionId).toBeTruthy();
    expect(decisions).toHaveLength(1);
    expect(Ingress.Events.RoutingDecision.schema.parse(decisions[0])).toMatchObject({
      inboundId: "t2",
      mode: "internal",
      stage: "surface_default",
      outcome: "route",
      actorId: "system:cron",
      factsUsed: expect.arrayContaining([
        "wait:none",
        "actor.system:system:cron",
        "surface.default:new",
        "target:resident",
      ]),
    });
    expect(order).toEqual(["publish", "execute"]);
  });

  // Salvaged from the pre-flip kernel-routing-access suite (its external
  // tests moved to the gateway router; the internal arm stayed brain-side).
  it("publishes one route decision and continues for internal Resident input", async () => {
    engine = makeEngine({
      residentRuntime: ResidentRuntime.create({
        runAgent: async () => ({ text: "resident response", finishReason: "stop" }),
      }),
      agentResolver: {
        resolve: async () => ({ model: { provider: "test", id: "test-model" } }),
      },
    });
    const decisions: unknown[] = [];
    const unsubscribe = Bus.observe((event, payload) => {
      if (event.name === "ingress.routing.decision") decisions.push(payload);
    });

    let result: Ingress.IngressResult;
    try {
      result = await engine.ingestInternal({
        id: "inbound-cron",
        traceId: "trace-test",
        surface: "cron",
        mode: "internal",
        agentName: "resident",
        payload: "run scheduled review",
      });
    } finally {
      unsubscribe();
    }

    if (result.kind === "dropped") throw new Error("shape");
    expect(result.result.output).toBe("resident response");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      inboundId: "inbound-cron",
      stage: "surface_default",
      outcome: "route",
      actorId: "system:cron",
    });
  });
});

describe("deliver() security", () => {
  it("rejects internal mode at the Deliver seam", async () => {
    // The pre-flip pin rejected mode:"internal" on engine.ingest(). The
    // external entry is now deliver(Gateway.Deliver), whose DeliveredEvent
    // pins the mode literal "direct" — same fail-closed ZodError.
    const delivery = {
      sessionId: crypto.randomUUID(),
      message: {
        messageId: "t3",
        traceId: "trace-test",
        surfaceKey: "discord::",
        text: "hack",
      },
      event: {
        id: "t3",
        traceId: "trace-test",
        surface: "discord",
        mode: "internal",
        agentName: "dev",
        payload: "hack",
      },
      decision: {
        traceId: "trace-test",
        time: Date.now(),
        inboundId: "t3",
        surface: "discord",
        mode: "direct",
        stage: "surface_default",
        outcome: "route",
        target: "resident",
        reason: "Inbound message routed to the surface session",
        factsUsed: ["wait:none"],
      },
    };

    const error = await catchError(engine.deliver(delivery));

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("invalid_literal");
  });
});
