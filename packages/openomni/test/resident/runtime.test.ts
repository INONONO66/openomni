import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PolicyEngine, type ChatAgentConfig } from "@openomni/agent";
import { Session, Storage } from "@openomni/ledger";
import { ResidentRuntime } from "../../src/resident/runtime";
import { newTraceId } from "@openomni/telemetry";

function makeEvent() {
  return {
    id: crypto.randomUUID(),
    traceId: "trace-test",
    surface: "slack",
    payload: "hello",
    mode: "direct" as const,
    meta: { target: { kind: "resident" as const } },
    agent: { model: { provider: "test", id: "fixture" } },
  };
}

async function evaluateTool(
  middleware: ChatAgentConfig["middleware"],
  context: {
    readonly sessionId: string;
    readonly runId: string;
    readonly toolName: string;
  },
) {
  const engine = PolicyEngine.create({ audit: false });
  for (const registration of middleware ?? []) {
    engine.register(registration);
  }
  return engine.dispatchPoint("tool.native.pre", {
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    sessionId: context.sessionId,
    runId: context.runId,
    toolName: context.toolName,
    toolId: context.toolName,
    toolInput: {},
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
      traceId: "trace-test",
      title: "resident-runtime-test",
      model: { providerID: "test", modelID: "fixture" },
    });

    const result = await manager.run({
      sessionId: session.id,
      traceContext: { traceId: newTraceId() },
      event: {
        id: "evt-resident-1",
        traceId: "trace-test",
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
      traceId: "trace-test",
      title: "resident-policy-plan-test",
      model: { providerID: "test", modelID: "fixture" },
    });

    const result = await manager.run({
      sessionId: session.id,
      traceContext: { traceId: newTraceId() },
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

    const policyContext = { sessionId: session.id, runId: result.runId };
    const planDecision = await evaluateTool(capturedConfig?.middleware, {
      ...policyContext,
      toolName: "tool:plan",
    });
    expect(planDecision).toMatchObject({ verdict: "allow" });
    const legacyDecision = await evaluateTool(capturedConfig?.middleware, {
      ...policyContext,
      toolName: "tool:legacy",
    });
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
      traceContext: { traceId: newTraceId() },
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
