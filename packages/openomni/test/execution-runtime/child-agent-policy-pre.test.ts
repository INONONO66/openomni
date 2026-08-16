import { describe, expect, test } from "bun:test";
import type { AgentResult, ChatAgentConfig } from "@openomni/agent";
import { PolicyDecision, type Model, type RuntimeResource } from "@openomni/protocol";
import {
  InjectionQueue,
  createChildAgentRuntime,
  type DelegationPolicyRegistration,
  type NativeTool,
} from "../../src/execution-runtime";
import { newTraceId } from "@openomni/telemetry";

const PARENT_TRACE_ID = newTraceId();

const model: Model.Ref = { provider: "test", id: "fixture" };
const successfulResult: AgentResult = {
  text: "done",
  steps: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  finishReason: "stop",
};

function makeTool(name: string): NativeTool {
  return {
    spec: { name, inputSchema: { type: "object", properties: {} } },
    riskTier: 0,
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    source: "system",
    execute: async (call) => ({ id: crypto.randomUUID(), toolCallId: call.id, output: name }),
  };
}

describe("child agent delegation pre-policy", () => {
  for (const verdict of ["deny", "pending"] as const) {
    test(`blocks without post settlement when delegation.worker.pre returns ${verdict}`, async () => {
      const pointIds: unknown[] = [];
      let created = false;
      const policy: DelegationPolicyRegistration = {
        kind: "point",
        name: `${verdict}-child`,
        pointIds: ["delegation.worker.pre", "delegation.worker.post"],
        effectCapabilities: {
          "delegation.worker.pre": ["audit.annotate"],
          "delegation.worker.post": ["audit.annotate"],
        },
        priority: 0,
        fn: (context) => {
          pointIds.push(context.pointId);
          if (context.pointId === "delegation.worker.post") {
            return PolicyDecision.allow({ policyId: `${verdict}-child` });
          }
          expect(context).toMatchObject({
            sessionId: "session-1",
            runId: "parent-run",
            workerProfile: { name: "child_agent", model, prompt: "blocked task" },
          });
          const options = {
            policyId: `${verdict}-child`,
            reasonCodes: ["delegation.blocked"],
          };
          return verdict === "deny"
            ? PolicyDecision.deny(options)
            : PolicyDecision.pending(options);
        },
      };
      const runtime = createChildAgentRuntime({
        model,
        parentMessages: [],
        parentTools: [],
        traceContext: { traceId: PARENT_TRACE_ID, sessionId: "session-1", runId: "parent-run" },
        delegationPolicies: [policy],
        createAgent: () => {
          created = true;
          return { run: async () => successfulResult };
        },
      });

      await expect(runtime.spawn({ prompt: "blocked task" })).rejects.toThrow("delegation.blocked");
      expect(pointIds).toEqual(["delegation.worker.pre"]);
      expect(created).toBe(false);
      expect(runtime.inspect()).toEqual([]);
    });
  }

  test("fails closed when delegation.worker.pre policy throws", async () => {
    let created = false;
    const runtime = createChildAgentRuntime({
      model,
      parentMessages: [],
      parentTools: [],
      traceContext: { traceId: PARENT_TRACE_ID, sessionId: "session-1", runId: "parent-run" },
      delegationPolicies: [
        {
          kind: "point",
          name: "broken-pre-policy",
          pointIds: ["delegation.worker.pre"],
          effectCapabilities: { "delegation.worker.pre": ["audit.annotate"] },
          priority: 0,
          fn: () => {
            throw new Error("policy unavailable");
          },
        },
      ],
      createAgent: () => {
        created = true;
        return { run: async () => successfulResult };
      },
    });

    await expect(runtime.spawn({ prompt: "must not start" })).rejects.toThrow();
    expect(created).toBe(false);
  });

  test("settles cancellation when an allowed pre policy aborts the parent", async () => {
    const contexts: Array<Record<string, unknown>> = [];
    const parentController = new AbortController();
    let created = false;
    const runtime = createChildAgentRuntime({
      model,
      parentMessages: [],
      parentTools: [],
      traceContext: { traceId: PARENT_TRACE_ID, sessionId: "session-1", runId: "parent-run" },
      parentSignal: parentController.signal,
      delegationPolicies: [
        {
          kind: "point",
          name: "abort-then-allow",
          pointIds: ["delegation.worker.pre", "delegation.worker.post"],
          effectCapabilities: {
            "delegation.worker.pre": ["audit.annotate"],
            "delegation.worker.post": ["audit.annotate"],
          },
          priority: 0,
          fn: (context) => {
            contexts.push(context);
            if (context.pointId === "delegation.worker.pre") parentController.abort();
            return PolicyDecision.allow({ policyId: "abort-then-allow" });
          },
        },
      ],
      createAgent: () => {
        created = true;
        return { run: async () => successfulResult };
      },
    });

    await expect(runtime.spawn({ prompt: "cancel after acceptance" })).rejects.toThrow(
      "parent worker run cancelled",
    );

    const [pre, post] = contexts;
    expect(contexts.map((context) => context.pointId)).toEqual([
      "delegation.worker.pre",
      "delegation.worker.post",
    ]);
    expect(post).toMatchObject({
      workerRunId: pre?.workerRunId,
      workerResult: { status: "cancelled", reason: "parent worker run cancelled" },
    });
    expect(created).toBe(false);
    expect(runtime.inspect()).toEqual([]);
  });

  test("preserves parent tool bounds and prevents nested delegation", async () => {
    const configs: ChatAgentConfig[] = [];
    const runtime = createChildAgentRuntime({
      model,
      traceContext: { traceId: PARENT_TRACE_ID, sessionId: "session-1", runId: "parent-run" },
      parentMessages: [],
      parentTools: [makeTool("read"), makeTool("dispatch"), makeTool("child_agent")],
      createAgent: (config) => {
        configs.push(config);
        return { run: async () => successfulResult };
      },
    });

    const child = await runtime.spawn({ prompt: "bounded", tools: { all: true } });
    await runtime.await([child.id]);

    expect(configs[0]?.tools?.map((tool) => tool.name)).toEqual(["read"]);
  });

  test("preserves the selected parent tool descriptor in child agent config", async () => {
    const configs: ChatAgentConfig[] = [];
    const descriptor: RuntimeResource.Descriptor = {
      id: "tool:mcp:server-1:remote.read",
      kind: "tool",
      labels: ["source:mcp", "capability.read"],
      capabilities: ["read"],
      effects: ["network.read"],
      risk: 2,
      source: { type: "mcp", serverId: "server-1", remoteName: "remote.read" },
    };
    const runtime = createChildAgentRuntime({
      model,
      traceContext: { traceId: PARENT_TRACE_ID, sessionId: "session-1", runId: "parent-run" },
      parentMessages: [],
      parentTools: [{ ...makeTool("mcp.remote.read"), descriptor }],
      createAgent: (config) => {
        configs.push(config);
        return { run: async () => successfulResult };
      },
    });

    const child = await runtime.spawn({ prompt: "preserve provenance", tools: { all: true } });
    await runtime.await([child.id]);

    expect(configs[0]?.tools?.[0]?.descriptor).toBe(descriptor);
  });

  test("serializes concurrent spawn admission at the child limit", async () => {
    let createCalls = 0;
    const runtime = createChildAgentRuntime({
      model,
      parentMessages: [],
      parentTools: [],
      traceContext: { traceId: PARENT_TRACE_ID, sessionId: "session-1", runId: "parent-run" },
      maxChildren: 1,
      createAgent: () => {
        createCalls += 1;
        return { run: () => new Promise<AgentResult>(() => undefined) };
      },
    });

    const results = await Promise.allSettled([
      runtime.spawn({ prompt: "first concurrent child" }),
      runtime.spawn({ prompt: "second concurrent child" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(createCalls).toBe(1);
    expect(runtime.inspect().filter((child) => child.status === "running")).toHaveLength(1);

    runtime.cancelAll();
    await runtime.await();
  });

  test("keeps cancelled settlement and injects completion when post audit fails", async () => {
    const injectionQueue = InjectionQueue.create();
    const runtime = createChildAgentRuntime({
      model,
      parentMessages: [],
      parentTools: [],
      traceContext: { traceId: PARENT_TRACE_ID, sessionId: "session-1", runId: "parent-run" },
      injectionQueue,
      delegationPolicies: [
        {
          kind: "point",
          name: "broken-terminal-audit",
          pointIds: ["delegation.worker.post"],
          effectCapabilities: { "delegation.worker.post": ["audit.annotate"] },
          priority: 0,
          fn: () => {
            throw new Error("audit unavailable");
          },
        },
      ],
      createAgent: () => ({ run: () => new Promise<AgentResult>(() => undefined) }),
    });

    const child = await runtime.spawn({ prompt: "cancel me", notifyOnComplete: true });
    runtime.cancel([child.id]);
    const [settled] = await runtime.await([child.id]);

    expect(settled).toMatchObject({ id: child.id, status: "cancelled" });
    expect(injectionQueue.drain("parent-run", "trace-child-policy")).toEqual([
      expect.objectContaining({
        output: expect.stringContaining(`[child_agent ${child.id} cancelled]`),
        injectToHistory: true,
      }),
    ]);
  });
});
