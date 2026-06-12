import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Ingress } from "@openomni/protocol";
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
  testState.runFn = defaultRunFn("engine-internal-test");
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
  IngressEngine.reset();
  Storage.initialize({ dbPath: ":memory:" });
  IngressEngine.setResidentRuntime(
    ResidentRuntime.create({
      runAgent: async (_config, input) => {
        testState.llmInputs.push(input);
        return { text: testState.responseQueue.shift() ?? "{}", finishReason: "stop" };
      },
    }),
  );
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
  it("throws when no resolver configured", async () => {
    const event: Ingress.InternalEvent = {
      id: "t1",
      surface: "cron",
      mode: "internal",
      agentName: "dev",
      payload: "hello",
    };

    const error = await catchError(IngressEngine.ingestInternal(event));

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("agent resolver not configured");
  });

  it("resolves agent and dispatches via resident runtime", async () => {
    IngressEngine.setAgentResolver({
      resolve: async () => mockAgentDef,
    });
    testState.responseQueue.push("cron result");

    const result = await IngressEngine.ingestInternal({
      id: "t2",
      surface: "cron",
      mode: "internal",
      agentName: "dev",
      payload: "run cron job",
    });

    expect(result.mode).toBe("internal");
    expect(result.sessionId).toBeTruthy();
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

    const error = await catchError(IngressEngine.ingest(event));

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("invalid_literal");
  });
});
