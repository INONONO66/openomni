import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { IngressEvent, type Ingress } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { Bus } from "@openomni/telemetry";
import {
  defaultRunFn,
  mockModelsGet,
  mockProviderFromModelsDevModel,
  resetTestState,
  testState,
} from "./_llm-mock";

type IngressEngine = import("../../src/ingress/engine").IngressEngine;
type IngressEngineDeps = import("../../src/ingress/engine").IngressEngineDeps;

let createIngressEngine: typeof import("../../src/ingress/engine")["createIngressEngine"];
let ResidentRuntime: typeof import("../../src/resident/runtime").ResidentRuntime;
let engine: IngressEngine;

beforeAll(async () => {
  ({ createIngressEngine } = await import("../../src/ingress/engine"));
  ({ ResidentRuntime } = await import("../../src/resident/runtime"));
});

afterAll(() => {
  mock.restore();
});

function makeEngine(overrides: IngressEngineDeps = {}): IngressEngine {
  return createIngressEngine({
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
    expect(IngressEvent.RoutingDecision.schema.parse(decisions[0])).toMatchObject({
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
    expect(IngressEvent.RoutingDecision.schema.parse(decisions[0])).toMatchObject({
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
});

describe("ingest() security", () => {
  it("rejects internal mode on external path", async () => {
    const event = {
      id: "t3",
      surface: "discord",
      mode: "internal",
      agentName: "dev",
      payload: "hack",
    };

    const error = await catchError(engine.ingest(event));

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("invalid_literal");
  });
});
