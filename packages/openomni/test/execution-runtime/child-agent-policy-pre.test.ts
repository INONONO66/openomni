import { describe, expect, test } from "bun:test";
import type { AgentResult, ChatAgentConfig } from "@openomni/agent";
import { PolicyDecision, type Model } from "@openomni/protocol";
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
  test("blocks before agent creation when delegation.worker.pre denies", async () => {
    let created = false;
    const policy: DelegationPolicyRegistration = {
      kind: "point",
      name: "deny-child",
      pointIds: ["delegation.worker.pre"],
      effectCapabilities: { "delegation.worker.pre": ["run.abort"] },
      priority: 0,
      fn: (context) => {
        expect(context).toMatchObject({
          pointId: "delegation.worker.pre",
          sessionId: "session-1",
          runId: "parent-run",
          workerProfile: { name: "child_agent", model, prompt: "blocked task" },
        });
        return PolicyDecision.deny({
          policyId: "deny-child",
          reasonCodes: ["delegation.denied"],
          effects: [{ type: "run.abort", reason: "delegation.denied" }],
        });
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

    await expect(runtime.spawn({ prompt: "blocked task" })).rejects.toThrow("delegation.denied");
    expect(created).toBe(false);
    expect(runtime.inspect()).toEqual([]);
  });

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
});
