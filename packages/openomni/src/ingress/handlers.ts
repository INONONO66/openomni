import { Plan, type Ingress, type Execution } from "@openomni/protocol";
import type { CoordinatorLike } from "./coordinator-like";
import { SessionBridge } from "./session-bridge";

export namespace IngressHandlers {
  export interface HandlerContext {
    sessionId: string;
    event: Ingress.InboundEvent;
    coordinator: CoordinatorLike;
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
      workspace: ctx.event.workspace,
      workspaceRoot: ctx.event.agent.toolConfig?.workspaceRoot,
    };
  }

  export async function handlePlan(
    ctx: HandlerContext,
  ): Promise<Extract<Ingress.IngressResult, { mode: "plan" }>> {
    if (ctx.event.mode !== "plan") {
      throw new Error("handlePlan requires plan mode event");
    }

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
    return { mode: "plan", sessionId: ctx.sessionId, result: planResult };
  }

  export async function handleDirect(
    ctx: HandlerContext,
  ): Promise<Extract<Ingress.IngressResult, { mode: "direct" }>> {
    if (ctx.event.mode !== "direct") {
      throw new Error("handleDirect requires direct mode event");
    }

    const request = buildExecutionRequest(ctx);
    const coordinatorResult = await ctx.coordinator.dispatch(ctx.sessionId, request);
    if (coordinatorResult.status !== "succeeded") {
      throw new Error(
        `Coordinator dispatch failed: ${coordinatorResult.error ?? coordinatorResult.status}`,
      );
    }
    const output = coordinatorResult.output ?? "";
    SessionBridge.storeDirectResult(ctx.sessionId, output, ctx.event.agent.model);
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
