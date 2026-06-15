import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PolicyEngine, type ChatAgentConfig } from "@openomni/agent";
import { IngressEvent } from "@openomni/protocol";
import { Bus, Session, Storage } from "@openomni/session";
import { ResidentRuntime } from "../../src/resident/runtime";

function makeEvent() {
  return {
    id: crypto.randomUUID(),
    surface: "slack",
    payload: "hello",
    mode: "direct" as const,
    meta: { target: { kind: "resident" as const } },
    agent: { model: { provider: "test", id: "fixture" } },
  };
}

async function evaluateTool(middleware: ChatAgentConfig["middleware"], toolName: string) {
  const engine = PolicyEngine.create({ audit: false });
  for (const registration of middleware ?? []) {
    engine.register(registration);
  }
  return engine.dispatch("invoke.prepare", {
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    toolName,
  });
}

describe("ResidentRuntime", () => {
  beforeEach(() => {
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
  });

  test("hydrates, runs, and releases idle activations", async () => {
    const manager = ResidentRuntime.create({
      idleTimeoutMs: 10,
      runAgent: async (_config, input) => ({
        text: `ran:${input.messages.length}`,
        finishReason: "stop",
      }),
    });

    const session = Session.create({
      title: "resident-runtime-test",
      model: { providerID: "test", modelID: "fixture" },
    });

    const result = await manager.run({
      sessionId: session.id,
      event: {
        id: "evt-resident-1",
        surface: "slack",
        payload: "hello",
        mode: "direct",
        meta: { target: { kind: "resident" } },
        agent: {
          model: { provider: "test", id: "fixture" },
        },
      },
    });

    expect(result.output).toBe("ran:0");
    expect(manager.getLifecycle(session.id)).toBe("idle");
    expect(manager.stats().activations).toBe(1);

    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    expect(manager.getLifecycle(session.id)).toBe("sleeping");
    expect(manager.stats().activations).toBe(0);
  });

  test("lets policyPlan own resident tool permissions", async () => {
    let capturedConfig: ChatAgentConfig | undefined;
    const manager = ResidentRuntime.create({
      runAgent: async (config) => {
        capturedConfig = config;
        return { text: "ok", finishReason: "stop" };
      },
    });

    const session = Session.create({
      title: "resident-policy-plan-test",
      model: { providerID: "test", modelID: "fixture" },
    });

    await manager.run({
      sessionId: session.id,
      event: {
        ...makeEvent(),
        agent: {
          model: { provider: "test", id: "fixture" },
          permissions: { action: "tool.call", allowlist: ["tool:legacy"] },
          policyPlan: {
            policies: [
              {
                id: "builtin:tool-permission",
                required: true,
                config: { permission: { action: "tool.call", allowlist: ["tool:plan"] } },
              },
            ],
            labels: ["security"],
          },
        },
      },
    });

    const planDecision = await evaluateTool(capturedConfig?.middleware, "tool:plan");
    expect(planDecision).toMatchObject({ verdict: "allow" });
    const legacyDecision = await evaluateTool(capturedConfig?.middleware, "tool:legacy");
    expect(legacyDecision).toMatchObject({ verdict: "deny" });
  });

  test("passes resolved worker execution context into tool executor factories", async () => {
    let factoryInput:
      | {
          readonly sessionId: string;
          readonly runId: string;
          readonly agentName?: string;
          readonly workspaceRoot?: string;
        }
      | undefined;
    const manager = ResidentRuntime.create({
      runAgent: async () => ({ text: "ok", finishReason: "stop" }),
    });

    await manager.run({
      sessionId: "resident-tool-factory",
      event: {
        ...makeEvent(),
        workspace: "/tmp/openomni-workspace",
        meta: { target: { kind: "resident" }, agentName: "resident-worker" },
        agent: {
          model: { provider: "test", id: "fixture" },
          toolExecutorFactory: (input) => {
            factoryInput = input;
            return async (call) => ({
              id: crypto.randomUUID(),
              toolCallId: call.id,
              output: "ok",
            });
          },
        },
      },
    });

    expect(factoryInput).toMatchObject({
      sessionId: "resident-tool-factory",
      agentName: "resident-worker",
      workspaceRoot: "/tmp/openomni-workspace",
    });
    expect(factoryInput?.runId).toBeString();
  });
});

test("ResidentRuntime enforces maximum resident activations", async () => {
  let markFirstRunStarted!: () => void;
  let releaseFirstRun!: () => void;
  const firstRunStarted = new Promise<void>((resolve) => {
    markFirstRunStarted = resolve;
  });
  const firstRunCanFinish = new Promise<void>((resolve) => {
    releaseFirstRun = resolve;
  });
  const manager = ResidentRuntime.create({
    maxActive: 1,
    idleTimeoutMs: 1_000,
    runAgent: async () => {
      markFirstRunStarted();
      await firstRunCanFinish;
      return { text: "ok", finishReason: "stop" };
    },
  });

  const firstRun = manager.run({ sessionId: "resident-a", event: makeEvent() });
  await firstRunStarted;

  let secondError: unknown;
  try {
    await Promise.resolve(manager.run({ sessionId: "resident-b", event: makeEvent() }));
  } catch (error) {
    secondError = error;
  }
  expect(secondError).toBeInstanceOf(Error);
  expect((secondError as Error).message).toContain("maximum resident activations reached");

  releaseFirstRun();
  await firstRun;
});

test("ResidentRuntime reuses fallback traceId for agent input and completion event", async () => {
  let inputTraceId: string | undefined;
  const completedTraceIds: string[] = [];
  const unsubscribe = Bus.subscribe(IngressEvent.Completed, (event) => {
    completedTraceIds.push(event.traceId);
  });

  const manager = ResidentRuntime.create({
    runAgent: async (_config, input) => {
      inputTraceId = input.traceContext?.traceId;
      return { text: "ok", finishReason: "stop" };
    },
  });

  try {
    await manager.run({ sessionId: "resident-trace", event: makeEvent() });
  } finally {
    unsubscribe();
  }

  expect(inputTraceId).toBeString();
  expect(completedTraceIds.at(-1)).toBe(inputTraceId);
});

test("ResidentRuntime does not start a queued run after it is aborted", async () => {
  let releaseFirstRun!: () => void;
  let firstRunStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    firstRunStarted = resolve;
  });
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirstRun = resolve;
  });
  let runCount = 0;
  const manager = ResidentRuntime.create({
    runAgent: async () => {
      runCount++;
      if (runCount === 1) {
        firstRunStarted();
        await firstCanFinish;
      }
      return { text: "ok", finishReason: "stop" };
    },
  });

  const firstRun = manager.run({ sessionId: "resident-queued-abort", event: makeEvent() });
  await firstStarted;

  const controller = new AbortController();
  const secondRun = manager.run({
    sessionId: "resident-queued-abort",
    event: makeEvent(),
    signal: controller.signal,
  });

  controller.abort();
  const secondError = await secondRun.catch((error) => error);
  expect(secondError).toBeInstanceOf(Error);
  expect((secondError as Error).name).toBe("AbortError");

  releaseFirstRun();
  await firstRun;
  await Bun.sleep(0);
  expect(runCount).toBe(1);
});
