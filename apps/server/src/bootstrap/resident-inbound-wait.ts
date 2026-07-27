import type { InboundWaitParams, InboundWaitResult } from "@openomni/coordinator";
import type { DispatchRuntime, WorkspaceIdentity } from "@openomni/openomni";
import type { Dispatch, Execution, Ledger } from "@openomni/protocol";

export type ResidentInboundWaitReference = Readonly<{
  waitId: string;
  correlation: Dispatch.Correlation;
}>;

export interface ResidentInboundWaitLedgerService {
  readonly queries: {
    attemptByExecution(input: { readonly sessionId: string; readonly runId: string }): Promise<
      | {
          readonly workItemId: string;
          readonly attemptId: string;
          readonly attemptSeq: number;
          readonly parentSessionId?: string;
          readonly status: string;
        }
      | undefined
    >;
  };
  readonly commands: {
    openResidentAsk(input: {
      readonly requestId: string;
      readonly sourceSessionId: string;
      readonly sourceRunId: string;
      readonly targetSessionId: string;
      readonly workItemId: string;
      readonly attemptId: string;
      readonly attemptSeq: number;
      readonly payload: string;
    }): Promise<ResidentInboundWaitReference>;
    resumeAfterResolvedWait(waitId: string): Promise<
      | Readonly<{
          disposition: "act";
          delivery: Readonly<{
            effect: Ledger.EffectRefV1;
            effectScope: Execution.EffectScopeV1;
          }>;
        }>
      | Readonly<{
          disposition: "reconcile";
          delivery: Readonly<{
            effect: Ledger.EffectRefV1;
            effectScope: Execution.EffectScopeV1;
          }>;
          outcome: "pending" | "unknown";
        }>
      | Readonly<{
          disposition: "terminal";
          delivery: Readonly<{
            effect: Ledger.EffectRefV1;
            effectScope: Execution.EffectScopeV1;
          }>;
          outcome: "confirmed" | "definite_failed";
        }>
    >;
    cancel(waitId: string, reason: string): Promise<void>;
  };
}

export interface ResidentInboundWaitSettlementService {
  readonly commands: {
    settleDelivery(input: {
      readonly attempt: {
        readonly workItemId: string;
        readonly attemptId: string;
        readonly attemptSeq: number;
        readonly sessionId: string;
        readonly runId: string;
        readonly status: "waiting";
      };
      readonly delivery: Readonly<{
        effect: Ledger.EffectRefV1;
        effectScope: Execution.EffectScopeV1;
      }>;
      readonly accepted: boolean;
    }): Promise<void>;
  };
}

export type ResidentInboundWaitConfig = {
  readonly workspaceIdentity: WorkspaceIdentity;
  readonly dispatchRuntime: Pick<DispatchRuntime, "submit">;
  readonly lifecycle: ResidentInboundWaitLedgerService;
  readonly settlements: ResidentInboundWaitSettlementService;
};

// The kernel resident.ask handler returns { output, finishReason }; test
// doubles may return the answer as a bare string.
function residentAskOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "output" in output) {
    const nested = (output as { output?: unknown }).output;
    if (typeof nested === "string") return nested;
  }
  return "";
}

export function createResidentInboundWaitHandler(
  config: ResidentInboundWaitConfig,
): (params: InboundWaitParams) => Promise<InboundWaitResult> {
  return async ({ workerId, sessionId, callId, runId, payload, workspaceRoot, signal }) => {
    const requestId = callId ?? crypto.randomUUID();
    const resolvedWorkspace = config.workspaceIdentity.canonicalRoot;
    if (workspaceRoot !== undefined && workspaceRoot !== resolvedWorkspace) {
      return { requestId, accepted: false, error: "worker.inbound_wait workspace mismatch" };
    }
    if (signal?.aborted) {
      return { requestId, accepted: false, error: "worker.inbound_wait aborted" };
    }

    if (!runId) {
      return { requestId, accepted: false, error: "worker.inbound_wait requires runId" };
    }
    const attempt = await config.lifecycle.queries.attemptByExecution({ sessionId, runId });
    const mainSessionId = attempt?.parentSessionId;
    if (!attempt || !mainSessionId) {
      return {
        requestId,
        accepted: false,
        error: `worker.inbound_wait requires an active Ledger attempt with parent Resident session: ${runId}`,
      };
    }
    const wait = await config.lifecycle.commands.openResidentAsk({
      requestId,
      sourceSessionId: sessionId,
      sourceRunId: runId,
      targetSessionId: mainSessionId,
      workItemId: attempt.workItemId,
      attemptId: attempt.attemptId,
      attemptSeq: attempt.attemptSeq,
      payload,
    });
    if (!wait.waitId || !wait.correlation.endpointId || !wait.correlation.channelId) {
      throw new Error("worker.inbound_wait kernel returned an invalid Wait reference");
    }

    let waitResolved = false;
    let failureReason = "worker.inbound_wait did not resolve";

    try {
      const dispatchResult = await config.dispatchRuntime.submit(
        {
          action: "resident.ask",
          target: { kind: "resident", sessionId: mainSessionId },
          payload: `Worker ${workerId}${runId ? ` run ${runId}` : ""} asks Resident:\n\n${payload}`,
          wait: true,
          correlation: wait.correlation,
          idempotencyKey: wait.waitId,
        },
        {
          sessionId,
          ...(runId ? { runId } : {}),
          attempt: {
            workItemId: attempt.workItemId,
            attemptId: attempt.attemptId,
            attemptSeq: attempt.attemptSeq,
          },
          actorKind: "worker",
          actorId: `${sessionId}:${runId ?? workerId}`,
          agentName: "worker",
          trustTier: "assigned_worker",
          workspaceRoot: resolvedWorkspace,
          ...(signal ? { signal } : {}),
        },
      );
      if (dispatchResult.status !== "completed") {
        failureReason =
          dispatchResult.error ??
          dispatchResult.reason ??
          `worker.inbound_wait dispatch ${dispatchResult.status}`;
        return {
          requestId: wait.waitId,
          accepted: false,
          error: failureReason,
        };
      }
      waitResolved = true;
      const disposition = await config.lifecycle.commands.resumeAfterResolvedWait(wait.waitId);
      if (disposition.disposition !== "act") {
        return {
          requestId: wait.waitId,
          accepted: false,
          error:
            disposition.disposition === "reconcile"
              ? `worker.inbound_wait delivery requires reconciliation: ${disposition.outcome}`
              : `worker.inbound_wait delivery already reached terminal outcome: ${disposition.outcome}`,
        };
      }
      const delivery = disposition.delivery;
      let deliverySettlement: "pending" | "settling" | "settled" = "pending";
      const settle = async (accepted: boolean) => {
        if (deliverySettlement !== "pending") {
          throw new Error("resident.ask delivery settlement was invoked more than once");
        }
        deliverySettlement = "settling";
        await config.settlements.commands.settleDelivery({
          attempt: {
            workItemId: attempt.workItemId,
            attemptId: attempt.attemptId,
            attemptSeq: attempt.attemptSeq,
            sessionId,
            runId,
            status: "waiting",
          },
          delivery,
          accepted,
        });
        deliverySettlement = "settled";
      };
      return {
        requestId: wait.waitId,
        accepted: true,
        output: residentAskOutput(dispatchResult.output),
        deliverySettlement: {
          confirmed: () => settle(true),
          failed: () => settle(false),
        },
      };
    } finally {
      if (!waitResolved) await config.lifecycle.commands.cancel(wait.waitId, failureReason);
    }
  };
}
