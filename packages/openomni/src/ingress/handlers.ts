import {
  IngressEvent,
  Plan,
  type Execution,
  type Ingress,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { Bus, Log } from "@openomni/session";
import type { CoordinatorLike } from "./coordinator-like";
import { SessionBridge } from "./session-bridge";

export namespace IngressHandlers {
  export interface HandlerContext {
    sessionId: string;
    event: Ingress.InboundEvent;
    coordinator: CoordinatorLike;
    traceContext?: TraceContextProtocol.Type;
  }

  function extractPrompt(payload: unknown): string {
    if (typeof payload === "string") return payload;
    if (
      payload &&
      typeof payload === "object" &&
      "text" in payload &&
      typeof (payload as { text: unknown }).text === "string"
    ) {
      return (payload as { text: string }).text;
    }
    return JSON.stringify(payload);
  }

  export function buildExecutionRequest(ctx: HandlerContext): Execution.Request {
    return {
      runId: crypto.randomUUID(),
      sessionId: ctx.sessionId,
      mode: ctx.event.mode,
      prompt: extractPrompt(ctx.event.payload),
      model: ctx.event.agent.model,
      systemPrompt: ctx.event.agent.systemPrompt,
      tools: ctx.event.agent.tools,
      toolConfig: ctx.event.agent.toolConfig,
      permissions: ctx.event.agent.permissions,
      credentials: undefined,
      budget: ctx.event.agent.budget,
      workspaceRoot: ctx.event.agent.toolConfig?.workspaceRoot,
      traceId: ctx.traceContext?.traceId,
    };
  }

  export async function handlePlan(
    ctx: HandlerContext,
  ): Promise<Extract<Ingress.IngressResult, { mode: "plan" }>> {
    if (ctx.event.mode !== "plan") {
      throw new Error("handlePlan requires plan mode event");
    }

    const log = ctx.traceContext ? Log.withContext({ traceId: ctx.traceContext.traceId }) : Log;

    log.info("dispatching plan mode", { sessionId: ctx.sessionId });

    if (ctx.traceContext) {
      Bus.publish(IngressEvent.ModeDetected, {
        traceId: ctx.traceContext.traceId,
        sessionId: ctx.sessionId,
        mode: "plan",
        time: Date.now(),
      });
    }

    const start = Date.now();
    const request = buildExecutionRequest(ctx);
    const coordinatorResult = await ctx.coordinator.dispatch(ctx.sessionId, request);
    if (coordinatorResult.status !== "succeeded") {
      throw new Error(
        `Coordinator dispatch failed: ${coordinatorResult.error ?? coordinatorResult.status}`,
      );
    }
    const raw = JSON.parse(coordinatorResult.output ?? "{}");
    const planResult = Plan.ResultSchema.parse(raw);
    SessionBridge.storePlanResult(ctx.sessionId, planResult, ctx.event.agent.model);

    if (ctx.traceContext) {
      Bus.publish(IngressEvent.Completed, {
        traceId: ctx.traceContext.traceId,
        sessionId: ctx.sessionId,
        mode: "plan",
        durationMs: Date.now() - start,
        time: Date.now(),
      });
    }

    return { mode: "plan", sessionId: ctx.sessionId, result: planResult };
  }

  export async function handleDirect(
    ctx: HandlerContext,
  ): Promise<Extract<Ingress.IngressResult, { mode: "direct" }>> {
    if (ctx.event.mode !== "direct") {
      throw new Error("handleDirect requires direct mode event");
    }

    const log = ctx.traceContext ? Log.withContext({ traceId: ctx.traceContext.traceId }) : Log;

    log.info("dispatching direct mode", { sessionId: ctx.sessionId });

    if (ctx.traceContext) {
      Bus.publish(IngressEvent.ModeDetected, {
        traceId: ctx.traceContext.traceId,
        sessionId: ctx.sessionId,
        mode: "direct",
        time: Date.now(),
      });
    }

    const start = Date.now();
    const request = buildExecutionRequest(ctx);
    const coordinatorResult = await ctx.coordinator.dispatch(ctx.sessionId, request);
    if (coordinatorResult.status !== "succeeded") {
      throw new Error(
        `Coordinator dispatch failed: ${coordinatorResult.error ?? coordinatorResult.status}`,
      );
    }
    const output = coordinatorResult.output ?? "";
    SessionBridge.storeDirectResult(ctx.sessionId, output, ctx.event.agent.model);

    if (ctx.traceContext) {
      Bus.publish(IngressEvent.Completed, {
        traceId: ctx.traceContext.traceId,
        sessionId: ctx.sessionId,
        mode: "direct",
        durationMs: Date.now() - start,
        time: Date.now(),
      });
    }

    return {
      mode: "direct",
      sessionId: ctx.sessionId,
      result: {
        output,
        finishReason: coordinatorResult.finishReason ?? "stop",
      },
    };
  }
}
