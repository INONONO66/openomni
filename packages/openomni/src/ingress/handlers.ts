import type { Ingress } from "@openomni/protocol";
import { publishCompleted, publishModeDetected, summarizeTarget } from "./handler-events";
import type { HandlerContext as IngressHandlerContext } from "./handler-types";
import { handleCancelRequest, handleWorkerDelivery } from "./handler-worker-dispatch";
import type { WorkerAttemptLifecycleService } from "./handler-worker-run";
import { IngressEventProjector } from "./event-projector";
import { dispatchWritebackCommit as commitWriteback } from "./handler-writeback";
import { resolveTarget } from "./target";

export namespace IngressHandlers {
  export interface HandlerContext extends IngressHandlerContext {
    readonly workerAttempts: WorkerAttemptLifecycleService;
  }

  export async function dispatchWritebackCommit(
    ctx: HandlerContext,
    output: string,
  ): Promise<string> {
    return commitWriteback(ctx, output);
  }

  export async function handleResident(ctx: HandlerContext): Promise<Ingress.IngressResult> {
    if (!ctx.residentRuntime) {
      throw new Error("resident runtime is required");
    }

    publishModeDetected(ctx, "resident");

    const residentResult = await ctx.residentRuntime.run({
      sessionId: ctx.sessionId,
      event: ctx.event,
      traceContext: ctx.traceContext,
      signal: (ctx.event.runtime as { signal?: AbortSignal } | undefined)?.signal,
    });
    const output = await commitWriteback(ctx, residentResult.output);
    await IngressEventProjector.projectResidentResult(
      ctx.event.id,
      ctx.sessionId,
      output,
      ctx.event.agent.model,
    );

    return {
      mode: ctx.event.mode,
      target: resolveTarget(ctx.event),
      sessionId: ctx.sessionId,
      result: {
        output,
        finishReason: residentResult.finishReason,
      },
    };
  }

  export async function handleDirect(ctx: HandlerContext): Promise<Ingress.IngressResult> {
    const target = summarizeTarget(ctx.event);
    publishModeDetected(ctx, target);

    const cancelResult = await handleCancelRequest(ctx, ctx.workerAttempts);
    if (cancelResult) return cancelResult;

    const start = Date.now();
    const deliveryResult = await handleWorkerDelivery(ctx, ctx.workerAttempts);
    if (deliveryResult) {
      publishCompleted(ctx, target, start);
      return deliveryResult;
    }

    throw new Error("worker ingress denied: no authoritative active Attempt accepted delivery");
  }
}
