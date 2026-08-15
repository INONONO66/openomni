import { describe, expect, test } from "bun:test";
import type { AgentResult } from "@openomni/agent";
import { PolicyDecision, type Model } from "@openomni/protocol";
import {
  createChildAgentRuntime,
  type DelegationPolicyRegistration,
} from "../../src/execution-runtime";
import { newTraceId } from "@openomni/telemetry";

const PARENT_TRACE_ID = newTraceId();

const model: Model.Ref = { provider: "test", id: "fixture" };
const successfulResult: AgentResult = {
  text: "child done",
  steps: [],
  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  finishReason: "stop",
};

describe("child agent synchronous run failure", () => {
  test("settles the accepted child once and releases its capacity", async () => {
    const postResults: unknown[] = [];
    const policy: DelegationPolicyRegistration = {
      kind: "point",
      name: "observe-post",
      pointIds: ["delegation.worker.post"],
      effectCapabilities: { "delegation.worker.post": ["audit.annotate"] },
      priority: 0,
      fn: (context) => {
        postResults.push(context.workerResult);
        return PolicyDecision.allow({ policyId: "observe-post" });
      },
    };
    let runCalls = 0;
    const runtime = createChildAgentRuntime({
      model,
      maxChildren: 1,
      parentMessages: [],
      parentTools: [],
      traceContext: { traceId: PARENT_TRACE_ID, sessionId: "session-1", runId: "parent-run" },
      delegationPolicies: [policy],
      createAgent: () => ({
        run: () => {
          runCalls += 1;
          if (runCalls === 1) throw new Error("run failed synchronously");
          return Promise.resolve(successfulResult);
        },
      }),
    });

    const failedChild = await runtime.spawn({ prompt: "fail synchronously" });
    const [failed] = await runtime.await([failedChild.id]);
    if (failed === undefined) throw new Error("shape");
    const nextChild = await runtime.spawn({ prompt: "reuse capacity" });
    const [completed] = await runtime.await([nextChild.id]);

    expect(failed).toMatchObject({ status: "failed", error: "run failed synchronously" });
    expect(runtime.inspect([failedChild.id])).toEqual([failed]);
    expect(completed).toMatchObject({ status: "completed", output: "child done" });
    expect(postResults).toEqual([
      { status: "failed", error: "run failed synchronously" },
      { status: "completed", result: successfulResult },
    ]);
  });
});
