import { PolicyEngine } from "@openomni/policy";
import { PolicyDecision, type TraceContext } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type {
  ChildAgentRuntimeOptions,
  ChildWorkerProfile,
  ChildWorkerResult,
  DelegationPolicyContext,
} from "./types.js";

export type DelegationPolicyRuntime = {
  readonly traceContext: TraceContext.Type;
  readonly dispatchPre: (workerRunId: string, workerProfile: ChildWorkerProfile) => Promise<void>;
  readonly dispatchPost: (workerRunId: string, workerResult: ChildWorkerResult) => Promise<void>;
};

class DelegationPolicyBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DelegationPolicyBlockedError";
  }
}

function resolveTraceContext(traceContext: TraceContext.Type | undefined): TraceContext.Type {
  return {
    ...traceContext,
    traceId: traceContext?.traceId ?? crypto.randomUUID(),
    sessionId: traceContext?.sessionId ?? crypto.randomUUID(),
    runId: traceContext?.runId ?? crypto.randomUUID(),
  };
}

export function createDelegationPolicyRuntime(
  options: ChildAgentRuntimeOptions,
): DelegationPolicyRuntime {
  const traceContext = resolveTraceContext(options.traceContext);
  const sessionId = traceContext.sessionId;
  const runId = traceContext.runId;
  const engine = PolicyEngine.create<DelegationPolicyContext>({
    traceContext,
    auditEmit: Bus.publish,
  });
  for (const registration of options.delegationPolicies ?? []) {
    engine.register(registration);
  }

  return {
    traceContext,
    async dispatchPre(workerRunId, workerProfile) {
      const decision = await engine.dispatchPoint("delegation.worker.pre", {
        traceContext,
        sessionId,
        runId,
        workerRunId,
        workerProfile,
      });
      if (PolicyDecision.isBlocking(decision)) {
        throw new DelegationPolicyBlockedError(PolicyDecision.reason(decision));
      }
    },
    async dispatchPost(workerRunId, workerResult) {
      await engine.dispatchPoint("delegation.worker.post", {
        traceContext,
        sessionId,
        runId,
        workerRunId,
        workerResult,
      });
    },
  };
}
