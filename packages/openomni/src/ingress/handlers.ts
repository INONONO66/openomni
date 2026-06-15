import type { Execution, Ingress } from "@openomni/protocol";
import {
  publishCompleted,
  publishFailed,
  publishModeDetected,
  summarizeTarget,
} from "./handler-events";
import { buildExecutionRequest as buildRequest } from "./handler-request";
import type { HandlerContext as IngressHandlerContext } from "./handler-types";
import {
  handleCancelRequest,
  handleWorkerDelivery,
  isBackgroundWorkerIngress,
  startBackgroundWorkerDispatch,
} from "./handler-worker-dispatch";
import {
  createDurableWorkerRun,
  finishCoordinatorDispatch,
  markDispatchThrown,
} from "./handler-worker-run";
import { dispatchWritebackCommit as commitWriteback } from "./handler-writeback";
import { SessionBridge } from "./session-bridge";
import { resolveTarget } from "./target";

export namespace IngressHandlers {
  export interface HandlerContext extends IngressHandlerContext {}

  export function buildExecutionRequest(ctx: HandlerContext): Execution.Request {
    return buildRequest(ctx);
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
    SessionBridge.storeDirectResult(ctx.sessionId, output, ctx.event.agent.model);

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

    const cancelResult = await handleCancelRequest(ctx);
    if (cancelResult) return cancelResult;

    const start = Date.now();
    const deliveryResult = await handleWorkerDelivery(ctx);
    if (deliveryResult) {
      publishCompleted(ctx, target, start);
      return deliveryResult;
    }

    const request = buildExecutionRequest(ctx);
    if (!ctx.coordinator) throw new Error("coordinator is required for worker-targeted ingress");
    await createDurableWorkerRun(ctx, request);
    if (isBackgroundWorkerIngress(ctx)) {
      startBackgroundWorkerDispatch(ctx, request, target, start);
      const output = await commitWriteback(
        ctx,
        JSON.stringify({
          accepted: true,
          status: "started",
          runId: request.runId,
          sessionId: ctx.sessionId,
        }),
      );
      SessionBridge.storeDirectResult(ctx.sessionId, output, ctx.event.agent.model);
      return {
        mode: ctx.event.mode,
        target: resolveTarget(ctx.event),
        sessionId: ctx.sessionId,
        result: { output, finishReason: "background" },
      };
    }
    let coordinatorResult: Execution.Result;
    try {
      coordinatorResult = await ctx.coordinator.dispatch(ctx.sessionId, request);
      await finishCoordinatorDispatch(ctx, request, coordinatorResult);
      if (coordinatorResult.status !== "succeeded") {
        if (coordinatorResult.status === "cancelled") {
          const output = await commitWriteback(
            ctx,
            coordinatorResult.output ?? coordinatorResult.error ?? "cancelled",
          );
          SessionBridge.storeDirectResult(ctx.sessionId, output, ctx.event.agent.model);
          publishCompleted(ctx, target, start);
          return {
            mode: ctx.event.mode,
            target: resolveTarget(ctx.event),
            sessionId: ctx.sessionId,
            result: {
              output,
              finishReason: coordinatorResult.finishReason ?? "cancelled",
            },
          };
        }
        throw new Error(
          `Coordinator dispatch failed: ${coordinatorResult.error ?? coordinatorResult.status}`,
        );
      }
    } catch (error) {
      publishFailed(ctx, target, start, error);
      await markDispatchThrown(ctx, request, error);
      throw error;
    }
    const output = await commitWriteback(ctx, coordinatorResult.output ?? "");
    SessionBridge.storeDirectResult(ctx.sessionId, output, ctx.event.agent.model);

    publishCompleted(ctx, target, start);

    return {
      mode: ctx.event.mode,
      target: resolveTarget(ctx.event),
      sessionId: ctx.sessionId,
      result: {
        output,
        finishReason: coordinatorResult.finishReason ?? "stop",
      },
    };
  }
}
