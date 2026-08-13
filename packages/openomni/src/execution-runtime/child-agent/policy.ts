import { PolicyEngine } from "@openomni/policy";
import { PolicyDecision, type TraceContext } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type {
  ChildAgentRuntimeOptions,
  ChildWorkerProfile,
  ChildWorkerResult,
  DelegationPolicyContext,
} from "./types.js";

export type ResolvedTraceContext = TraceContext.Type & {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId: string;
};

export type DelegationPolicyRuntime = {
  readonly traceContext: ResolvedTraceContext;
  readonly dispatchPre: (workerRunId: string, workerProfile: ChildWorkerProfile) => Promise<void>;
  readonly dispatchPost: (workerRunId: string, workerResult: ChildWorkerResult) => Promise<void>;
};

class DelegationPolicyBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DelegationPolicyBlockedError";
  }
}

/**
 * A child agent inherits its parent's trace. Minting one here would give the
 * delegation its own trace, disconnected from the run that ordered it — which
 * is the failure this exists to prevent, not a default worth having.
 */
function resolveTraceContext(traceContext: TraceContext.Type | undefined): ResolvedTraceContext {
  const traceId = nonEmptyString(traceContext?.traceId);
  const sessionId = nonEmptyString(traceContext?.sessionId);
  const runId = nonEmptyString(traceContext?.runId);
  if (traceId === undefined || sessionId === undefined || runId === undefined) {
    throw new Error("child agent delegation requires the parent trace context");
  }
  return { ...traceContext, traceId, sessionId, runId };
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
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
