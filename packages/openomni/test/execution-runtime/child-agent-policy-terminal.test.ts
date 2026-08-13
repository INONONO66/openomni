import { describe, expect, test } from "bun:test";
import type { AgentResult } from "@openomni/agent";
import { PolicyDecision, PolicyEvent, type Model } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import {
  ChildAgentEvents,
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

function observingPolicy(contexts: Array<Record<string, unknown>>): DelegationPolicyRegistration {
  return {
    kind: "point",
    name: "observe-delegation",
    pointIds: ["delegation.worker.pre", "delegation.worker.post"],
    effectCapabilities: {
      "delegation.worker.pre": ["audit.annotate"],
      "delegation.worker.post": ["audit.annotate"],
    },
    priority: 0,
    fn: (context) => {
      contexts.push(context);
      return PolicyDecision.allow({ policyId: "observe-delegation" });
    },
  };
}

function postContexts(contexts: readonly Record<string, unknown>[]) {
  return contexts.filter((context) => context.pointId === "delegation.worker.post");
}

describe("child agent delegation terminal policy", () => {
  test("dispatches one post decision with the completed worker result", async () => {
    const contexts: Array<Record<string, unknown>> = [];
    const composed: Array<{ pointId?: string; pointVersion?: number }> = [];
    const unsubscribe = Bus.subscribe(PolicyEvent.DecisionComposed, (event) =>
      composed.push(event),
    );
    const runtime = createChildAgentRuntime({
      model,
      parentMessages: [],
      parentTools: [],
      traceContext: { traceId: PARENT_TRACE_ID, sessionId: "session-1", runId: "parent-run" },
      delegationPolicies: [observingPolicy(contexts)],
      createAgent: () => ({ run: async () => successfulResult }),
    });

    try {
      const child = await runtime.spawn({ prompt: "complete" });
      await runtime.await([child.id]);

      const [pre] = contexts;
      const posts = postContexts(contexts);
      const [post] = posts;
      expect(posts).toHaveLength(1);
      expect(pre).toMatchObject({
        pointId: "delegation.worker.pre",
        sessionId: expect.any(String),
        runId: expect.any(String),
        workerRunId: child.id,
      });
      expect(post).toMatchObject({
        pointId: "delegation.worker.post",
        sessionId: pre?.sessionId,
        runId: pre?.runId,
        workerRunId: child.id,
        workerResult: { status: "completed", result: successfulResult },
      });
      expect(composed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ pointId: "delegation.worker.pre", pointVersion: 1 }),
          expect.objectContaining({ pointId: "delegation.worker.post", pointVersion: 1 }),
        ]),
      );
    } finally {
      unsubscribe();
      Bus.reset();
    }
  });

  test("dispatches one post decision with the failed worker result", async () => {
    const contexts: Array<Record<string, unknown>> = [];
    const runtime = createChildAgentRuntime({
      model,
      parentMessages: [],
      parentTools: [],
      traceContext: { traceId: PARENT_TRACE_ID, sessionId: "session-1", runId: "parent-run" },
      delegationPolicies: [observingPolicy(contexts)],
      createAgent: () => ({
        run: async () => {
          throw new Error("provider failed");
        },
      }),
    });

    const child = await runtime.spawn({ prompt: "fail" });
    await runtime.await([child.id]);

    expect(postContexts(contexts)).toEqual([
      expect.objectContaining({
        workerRunId: child.id,
        workerResult: { status: "failed", error: "provider failed" },
      }),
    ]);
  });

  test("dispatches one post decision with the cancelled worker result", async () => {
    const contexts: Array<Record<string, unknown>> = [];
    const runtime = createChildAgentRuntime({
      model,
      parentMessages: [],
      parentTools: [],
      traceContext: { traceId: PARENT_TRACE_ID, sessionId: "session-1", runId: "parent-run" },
      delegationPolicies: [observingPolicy(contexts)],
      createAgent: () => ({ run: () => new Promise<AgentResult>(() => undefined) }),
    });

    const child = await runtime.spawn({ prompt: "cancel" });
    runtime.cancel([child.id]);
    runtime.cancel([child.id]);
    await runtime.await([child.id]);

    expect(postContexts(contexts)).toEqual([
      expect.objectContaining({
        workerRunId: child.id,
        workerResult: { status: "cancelled", reason: "child agent cancelled" },
      }),
    ]);
  });

  test("preserves cancellation completion when run synchronously aborts the parent", async () => {
    const contexts: Array<Record<string, unknown>> = [];
    const parentController = new AbortController();
    const runtime = createChildAgentRuntime({
      model,
      parentMessages: [],
      parentTools: [],
      traceContext: { traceId: PARENT_TRACE_ID, sessionId: "session-1", runId: "parent-run" },
      parentSignal: parentController.signal,
      awaitTimeoutMs: 25,
      delegationPolicies: [observingPolicy(contexts)],
      createAgent: () => ({
        run: () => {
          parentController.abort();
          return new Promise<AgentResult>(() => undefined);
        },
      }),
    });

    const child = await runtime.spawn({ prompt: "abort synchronously in run" });
    const [settled] = await runtime.await([child.id]);
    runtime.cancel([child.id]);
    await runtime.await([child.id]);

    expect(settled).toMatchObject({ status: "cancelled" });
    expect(postContexts(contexts)).toEqual([
      expect.objectContaining({
        workerRunId: child.id,
        workerResult: { status: "cancelled", reason: "parent worker run cancelled" },
      }),
    ]);
  });

  for (const cancellationSource of ["parentTools", "createAgent"] as const) {
    test(`settles cancellation once when ${cancellationSource} aborts the parent during spawn`, async () => {
      const contexts: Array<Record<string, unknown>> = [];
      const parentController = new AbortController();
      const cancelledRunIds: string[] = [];
      let childSignal: AbortSignal | undefined;
      let runCalls = 0;
      const unsubscribe = Bus.subscribe(ChildAgentEvents.Cancelled, (event) => {
        cancelledRunIds.push(event.runId);
      });
      const runtime = createChildAgentRuntime({
        model,
        parentMessages: [],
        parentTools:
          cancellationSource === "parentTools"
            ? () => {
                parentController.abort();
                return [];
              }
            : [],
        parentSignal: parentController.signal,
        traceContext: { traceId: PARENT_TRACE_ID, sessionId: "session-1", runId: "parent-run" },
        delegationPolicies: [observingPolicy(contexts)],
        createAgent: (config) => {
          childSignal = config.signal;
          if (cancellationSource === "createAgent") parentController.abort();
          return {
            run: async () => {
              runCalls += 1;
              return successfulResult;
            },
          };
        },
      });

      try {
        const child = await runtime.spawn({ prompt: "cancel during construction" });
        const [settled] = await runtime.await([child.id]);

        expect(childSignal?.aborted).toBe(cancellationSource === "createAgent" ? true : undefined);
        expect(runCalls).toBe(0);
        expect(settled?.status).toBe("cancelled");
        expect(runtime.inspect().filter((record) => record.status === "running")).toEqual([]);
        expect(cancelledRunIds).toEqual([child.id]);
        expect(postContexts(contexts)).toEqual([
          expect.objectContaining({
            workerRunId: child.id,
            workerResult: {
              status: "cancelled",
              reason: "parent worker run cancelled",
            },
          }),
        ]);
      } finally {
        unsubscribe();
        Bus.reset();
      }
    });
  }

  test("fails open when delegation.worker.post policy throws", async () => {
    const runtime = createChildAgentRuntime({
      model,
      parentMessages: [],
      parentTools: [],
      traceContext: { traceId: PARENT_TRACE_ID, sessionId: "session-1", runId: "parent-run" },
      delegationPolicies: [
        {
          kind: "point",
          name: "broken-post-policy",
          pointIds: ["delegation.worker.post"],
          effectCapabilities: { "delegation.worker.post": ["audit.annotate"] },
          priority: 0,
          fn: () => {
            throw new Error("audit unavailable");
          },
        },
      ],
      createAgent: () => ({ run: async () => successfulResult }),
    });

    const child = await runtime.spawn({ prompt: "complete despite audit" });
    const [settled] = await runtime.await([child.id]);

    expect(settled).toMatchObject({ status: "completed", output: "child done" });
  });
});
