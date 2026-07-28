import type { Execution, Ingress } from "@openomni/protocol";
import type { HandlerContext } from "./handler-types";
import { publishCompleted, publishFailed } from "./handler-events";
import { extractPrompt } from "./handler-prompt";
import {
  finishCoordinatorDispatch,
  markDispatchThrown,
  type WorkerAttemptLifecycleService,
} from "./handler-worker-run";
import { dispatchWritebackCommit } from "./handler-writeback";
import { SessionBridge } from "./session-bridge";
import { resolveTarget } from "./target";

export function isBackgroundWorkerIngress(ctx: HandlerContext): boolean {
  return (ctx.event.runtime as { background?: unknown } | undefined)?.background === true;
}

export async function handleCancelRequest(
  ctx: HandlerContext,
  lifecycle: WorkerAttemptLifecycleService,
): Promise<Ingress.IngressResult | undefined> {
  if (ctx.event.runtime?.lifecycle !== "stopping") return undefined;
  if (!ctx.coordinator?.cancelRun) {
    throw new Error("coordinator cancellation is required for worker cancellation");
  }

  const active = await lifecycle.queries.active({
    sessionId: ctx.sessionId,
    ...(ctx.event.runtime?.runId ? { runId: ctx.event.runtime.runId } : {}),
  });
  const results = await Promise.all(
    active.map(async (run) => {
      await lifecycle.commands.requestCancel(run);
      let result: unknown;
      try {
        result = await ctx.coordinator?.cancelRun?.(run.runId);
      } catch (error) {
        await lifecycle.commands.settleCancel({ attempt: run, cancelled: false });
        throw error;
      }
      const cancelled =
        result !== null &&
        typeof result === "object" &&
        (result as { cancelled?: unknown }).cancelled === true;
      await lifecycle.commands.settleCancel({ attempt: run, cancelled });
      return { runId: run.runId, cancelled, result };
    }),
  );
  const output = await dispatchWritebackCommit(
    ctx,
    JSON.stringify({
      cancelled: results.filter((run) => run.cancelled).length,
      requested: results.length,
      runs: results,
    }),
  );
  SessionBridge.storeDirectResult(ctx.sessionId, output, ctx.event.agent.model);
  return {
    mode: ctx.event.mode,
    target: resolveTarget(ctx.event),
    sessionId: ctx.sessionId,
    result: { output, finishReason: "cancelled" },
  };
}

export async function handleWorkerDelivery(
  ctx: HandlerContext,
  lifecycle: WorkerAttemptLifecycleService,
): Promise<Ingress.IngressResult | undefined> {
  const target = resolveTarget(ctx.event);
  if (target.kind !== "worker" || !ctx.coordinator?.deliverMessage) return undefined;
  const attempts = await lifecycle.queries.active({
    sessionId: ctx.sessionId,
    ...(ctx.event.runtime?.runId ? { runId: ctx.event.runtime.runId } : {}),
  });
  const [attempt] = attempts;
  if (attempts.length !== 1 || !attempt) return undefined;
  const payload = extractPrompt(ctx.event.payload);
  const disposition = await lifecycle.commands.requestDelivery({
    attempt,
    deliveryId: ctx.event.id,
    payload,
  });
  if (disposition.disposition === "reconcile") return undefined;
  const replayOutput = JSON.stringify({
    delivered: true,
    sessionId: attempt.sessionId,
    runId: attempt.runId,
  });
  if (disposition.disposition === "terminal") {
    if (disposition.outcome === "definite_failed") return undefined;
    return {
      mode: ctx.event.mode,
      target,
      sessionId: ctx.sessionId,
      result: { output: replayOutput, finishReason: "delivered" },
    };
  }
  let raw: unknown;
  try {
    raw = await ctx.coordinator.deliverMessage(attempt.sessionId, payload, attempt.runId);
  } catch (error) {
    await lifecycle.commands.settleDelivery({
      attempt,
      delivery: disposition.delivery,
      accepted: false,
    });
    throw error;
  }
  const accepted =
    raw !== null && typeof raw === "object" && (raw as { accepted?: unknown }).accepted === true;
  await lifecycle.commands.settleDelivery({
    attempt,
    delivery: disposition.delivery,
    accepted,
  });
  if (!accepted) return undefined;

  const output = await dispatchWritebackCommit(ctx, replayOutput);
  SessionBridge.storeDirectResult(ctx.sessionId, output, ctx.event.agent.model);
  return {
    mode: ctx.event.mode,
    target,
    sessionId: ctx.sessionId,
    result: { output, finishReason: "delivered" },
  };
}

export function startBackgroundWorkerDispatch(
  ctx: HandlerContext,
  request: Execution.Request,
  target: string | undefined,
  start: number,
  lifecycle: WorkerAttemptLifecycleService,
): void {
  if (!ctx.coordinator) throw new Error("coordinator is required for worker-targeted ingress");
  const coordinator = ctx.coordinator;

  void (async () => {
    try {
      const result = await coordinator.dispatch(ctx.sessionId, request);
      await finishCoordinatorDispatch(ctx, request, result, lifecycle);
      if (result.output) {
        SessionBridge.storeDirectResult(ctx.sessionId, result.output, ctx.event.agent.model);
      }
      if (result.status === "succeeded" || result.status === "cancelled") {
        publishCompleted(ctx, target, start);
        return;
      }
      publishFailed(ctx, target, start, result.error ?? result.status);
    } catch (error) {
      publishFailed(ctx, target, start, error);
      await markDispatchThrown(ctx, request, error, lifecycle);
    }
  })();
}
