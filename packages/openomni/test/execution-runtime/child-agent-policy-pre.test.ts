import { describe, expect, test } from "bun:test";
import type { AgentResult, ChatAgentConfig } from "@openomni/agent";
import { PolicyDecision, type Model, type RuntimeResource } from "@openomni/protocol";
import {
  createChildAgentRuntime,
  type DelegationPolicyRegistration,
  type NativeTool,
} from "../../src/execution-runtime";

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
          "delegation.worker.pre": ["run.abort"],
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
            effects: [{ type: "run.abort" as const, reason: "delegation.blocked" }],
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
        traceContext: { traceId: "trace-1", sessionId: "session-1", runId: "parent-run" },
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
      labels: ["source.mcp", "capability.read"],
      capabilities: ["read"],
      effects: ["network.read"],
      risk: 2,
      source: { type: "mcp", serverId: "server-1", remoteName: "remote.read" },
    };
    const runtime = createChildAgentRuntime({
      model,
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
});
