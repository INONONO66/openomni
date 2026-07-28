import { describe, expect, test } from "bun:test";
import type { AgentResult } from "@openomni/agent";
import { PolicyDecision, type Model } from "@openomni/protocol";
import {
  createChildAgentRuntime,
  type DelegationPolicyRegistration,
} from "../../src/execution-runtime";
import { createTestLlmEnvironment } from "../helpers/llm-environment.ts";

const model: Model.Ref = { provider: "test", id: "fixture" };
const { environment, modelCatalog } = createTestLlmEnvironment();
const successfulResult: AgentResult = {
  text: "child done",
  steps: [],
  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  finishReason: "stop",
};

function observingPolicy(contexts: Array<Record<string, unknown>>): DelegationPolicyRegistration {
  return {
    kind: "point",
    name: "observe-construction",
    pointIds: ["delegation.worker.pre", "delegation.worker.post"],
    effectCapabilities: {
      "delegation.worker.pre": ["audit.annotate"],
      "delegation.worker.post": ["audit.annotate"],
    },
    priority: 0,
    fn: (context) => {
      contexts.push(context);
      return PolicyDecision.allow({ policyId: "observe-construction" });
    },
  };
}

function contextsAt(
  contexts: readonly Record<string, unknown>[],
  pointId: "delegation.worker.pre" | "delegation.worker.post",
) {
  return contexts.filter((context) => context.pointId === pointId);
}

describe("child agent delegation construction settlement", () => {
  for (const failure of [
    {
      name: "parent tool selection",
      error: "tool selection failed",
      parentTools: () => {
        throw new Error("tool selection failed");
      },
      createAgent: () => ({ run: async () => successfulResult }),
    },
    {
      name: "agent creation",
      error: "agent factory failed",
      parentTools: [],
      createAgent: () => {
        throw new Error("agent factory failed");
      },
    },
  ] as const) {
    test(`dispatches one failed post when ${failure.name} fails after pre approval`, async () => {
      const contexts: Array<Record<string, unknown>> = [];
      const runtime = createChildAgentRuntime({
        ...{ environment, modelCatalog },
        model,
        parentMessages: [],
        parentTools: failure.parentTools,
        delegationPolicies: [observingPolicy(contexts)],
        createAgent: failure.createAgent,
      });

      await expect(runtime.spawn({ prompt: "construct child" })).rejects.toThrow(failure.error);

      const [pre] = contextsAt(contexts, "delegation.worker.pre");
      expect(contextsAt(contexts, "delegation.worker.post")).toEqual([
        expect.objectContaining({
          workerRunId: pre?.workerRunId,
          workerResult: { status: "failed", error: failure.error },
        }),
      ]);
      expect(runtime.inspect()).toEqual([]);
    });
  }

  test("dispatches one failed post when the child limit rejects after pre approval", async () => {
    const contexts: Array<Record<string, unknown>> = [];
    const runtime = createChildAgentRuntime({
      ...{ environment, modelCatalog },
      model,
      parentMessages: [],
      parentTools: [],
      maxChildren: 1,
      delegationPolicies: [observingPolicy(contexts)],
      createAgent: () => ({ run: () => new Promise<AgentResult>(() => undefined) }),
    });
    const first = await runtime.spawn({ prompt: "first child" });

    try {
      await expect(runtime.spawn({ prompt: "second child" })).rejects.toThrow(
        "child agent limit reached: 1",
      );

      const secondPre = contextsAt(contexts, "delegation.worker.pre")[1];
      expect(contextsAt(contexts, "delegation.worker.post")).toEqual([
        expect.objectContaining({
          workerRunId: secondPre?.workerRunId,
          workerResult: { status: "failed", error: "child agent limit reached: 1" },
        }),
      ]);
      expect(runtime.inspect()).toEqual([
        expect.objectContaining({ id: first.id, status: "running" }),
      ]);
    } finally {
      runtime.cancelAll();
      await runtime.await([first.id]);
    }
  });
});
