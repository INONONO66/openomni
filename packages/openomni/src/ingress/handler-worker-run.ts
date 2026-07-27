import type { Execution, Ledger } from "@openomni/protocol";
import type { HandlerContext } from "./handler-types";

export type WorkerAttemptTerminalStatus = "succeeded" | "failed" | "cancelled" | "interrupted";

export interface WorkerAttemptProjection {
  readonly workItemId: string;
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly parentSessionId?: string;
  readonly status: "allocated" | "starting" | "running" | "waiting" | WorkerAttemptTerminalStatus;
}

export interface WorkerDeliveryBindingV1 {
  readonly effect: Ledger.EffectRefV1;
  readonly effectScope: Execution.EffectScopeV1;
}

export type WorkerDeliveryDispositionV1 =
  | Readonly<{ disposition: "act"; delivery: WorkerDeliveryBindingV1 }>
  | Readonly<{
      disposition: "reconcile";
      delivery: WorkerDeliveryBindingV1;
      outcome: "pending" | "unknown";
    }>
  | Readonly<{
      disposition: "terminal";
      delivery: WorkerDeliveryBindingV1;
      outcome: "confirmed" | "definite_failed";
    }>;

export interface WorkerAttemptLifecycleService {
  readonly commands: {
    requestStart(attempt: WorkerAttemptProjection): Promise<void>;
    finish(input: {
      readonly attempt: WorkerAttemptProjection;
      readonly status: WorkerAttemptTerminalStatus;
      readonly error?: string;
    }): Promise<void>;
    requestDelivery(input: {
      readonly attempt: WorkerAttemptProjection;
      readonly deliveryId: string;
      readonly payload: string;
    }): Promise<WorkerDeliveryDispositionV1>;
    settleDelivery(input: {
      readonly attempt: WorkerAttemptProjection;
      readonly delivery: WorkerDeliveryBindingV1;
      readonly accepted: boolean;
    }): Promise<void>;
    requestCancel(attempt: WorkerAttemptProjection): Promise<void>;
    settleCancel(input: {
      readonly attempt: WorkerAttemptProjection;
      readonly cancelled: boolean;
    }): Promise<void>;
  };
  readonly queries: {
    byExecution(input: {
      readonly sessionId: string;
      readonly runId: string;
    }): Promise<WorkerAttemptProjection | undefined>;
    active(input: {
      readonly sessionId: string;
      readonly runId?: string;
    }): Promise<readonly WorkerAttemptProjection[]>;
  };
}

export async function finishCoordinatorDispatch(
  ctx: HandlerContext,
  request: Execution.Request,
  coordinatorResult: Execution.Result,
  lifecycle: WorkerAttemptLifecycleService,
): Promise<void> {
  const attempt = await lifecycle.queries.byExecution({
    sessionId: ctx.sessionId,
    runId: request.runId,
  });
  if (!attempt) throw new Error(`Ledger attempt not found for run ${request.runId}`);
  await lifecycle.commands.finish({
    attempt,
    status: coordinatorResult.status,
    ...(coordinatorResult.error ? { error: coordinatorResult.error } : {}),
  });
}

export async function markDispatchThrown(
  ctx: HandlerContext,
  request: Execution.Request,
  error: unknown,
  lifecycle: WorkerAttemptLifecycleService,
): Promise<void> {
  const attempt = await lifecycle.queries.byExecution({
    sessionId: ctx.sessionId,
    runId: request.runId,
  });
  if (!attempt) throw new Error(`Ledger attempt not found for run ${request.runId}`);
  await lifecycle.commands.finish({
    attempt,
    status: "interrupted",
    error: error instanceof Error ? error.message : String(error),
  });
}
