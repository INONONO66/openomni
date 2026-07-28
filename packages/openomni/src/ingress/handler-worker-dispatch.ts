import type { Execution, Ingress } from "@openomni/protocol";
import { WorkerRun } from "@openomni/session";
import type { HandlerContext } from "./handler-types";
import { publishCompleted, publishFailed } from "./handler-events";
import { extractPrompt } from "./handler-prompt";
import { finishCoordinatorDispatch, markDispatchThrown } from "./handler-worker-run";
import { dispatchWritebackCommit } from "./handler-writeback";
import { SessionBridge } from "./session-bridge";
import { resolveTarget } from "./target";

export function isBackgroundWorkerIngress(ctx: HandlerContext): boolean {
  return (ctx.event.runtime as { background?: unknown } | undefined)?.background === true;
}

export async function handleCancelRequest(
  ctx: HandlerContext,
): Promise<Ingress.IngressResult | undefined> {
  if (ctx.event.runtime?.lifecycle !== "stopping") return undefined;
  if (!ctx.coordinator?.cancelRun) {
    throw new Error("coordinator cancellation is required for worker cancellation");
  }

  const requestedRunId = ctx.event.runtime?.runId;
  const active = (await WorkerRun.listBySession(ctx.sessionId)).filter(
    (run) =>
      ["starting", "running", "waiting_input"].includes(run.status) &&
      (!requestedRunId || run.runId === requestedRunId),
  );
  const results = await Promise.all(
    active.map(async (run) => {
      const result = await ctx.coordinator?.cancelRun?.(run.runId);
      const cancelled =
        result !== null &&
        typeof result === "object" &&
        (result as { cancelled?: unknown }).cancelled === true;
      if (cancelled) {
        await WorkerRun.updateStatus(ctx.sessionId, run.runId, "cancelled", {
          endedAt: Date.now(),
        });
      }
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
): Promise<Ingress.IngressResult | undefined> {
  const target = resolveTarget(ctx.event);
  if (target.kind !== "worker" || !ctx.coordinator?.deliverMessage) return undefined;

  const raw = await ctx.coordinator.deliverMessage(
    ctx.sessionId,
    extractPrompt(ctx.event.payload),
    ctx.event.runtime?.runId,
  );
  const accepted =
    raw !== null && typeof raw === "object" && (raw as { accepted?: unknown }).accepted === true;
  if (!accepted) return undefined;

  const output = await dispatchWritebackCommit(
    ctx,
    JSON.stringify({
      delivered: true,
      sessionId: ctx.sessionId,
      runId: ctx.event.runtime?.runId,
    }),
  );
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
): void {
  if (!ctx.coordinator) throw new Error("coordinator is required for worker-targeted ingress");
  const coordinator = ctx.coordinator;

  void (async () => {
    try {
      const result = await coordinator.dispatch(ctx.sessionId, request);
      await finishCoordinatorDispatch(ctx, request, result);
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
      await markDispatchThrown(ctx, request, error);
    }
  })();
}
