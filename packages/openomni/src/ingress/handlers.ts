import { ChatAgent } from "@openomni/agent";
import {
  type Execution,
  PlanResultSchema,
  type InboundEvent,
  type IngressResult,
} from "@openomni/protocol";
import type { CoordinatorLike } from "./coordinator-like";
import { SessionBridge } from "./session-bridge";
import { PlanAgent } from "../plan/plan-agent";
import { normalizePlanPayload } from "../plan/plan-json";

export namespace IngressHandlers {
  export interface HandlerContext {
    sessionId: string;
    event: InboundEvent;
    coordinator?: CoordinatorLike;
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
    };
  }

  export async function handlePlan(
    ctx: HandlerContext,
  ): Promise<Extract<IngressResult, { mode: "plan" }>> {
    if (ctx.event.mode !== "plan") {
      throw new Error("handlePlan requires plan mode event");
    }

    if (ctx.coordinator) {
      const request = buildExecutionRequest(ctx);
      const coordinatorResult = await ctx.coordinator.dispatch(ctx.sessionId, request);
      if (coordinatorResult.status !== "succeeded") {
        throw new Error(
          `Coordinator dispatch failed: ${coordinatorResult.error ?? coordinatorResult.status}`,
        );
      }
      const raw = JSON.parse(coordinatorResult.output ?? "{}");
      const normalized = { ...raw, plan: normalizePlanPayload(raw.plan) };
      const planResult = PlanResultSchema.parse(normalized);
      SessionBridge.storePlanResult(ctx.sessionId, planResult, ctx.event.agent.model);
      return { mode: "plan", sessionId: ctx.sessionId, result: planResult };
    }

    const goal = SessionBridge.buildPlanGoal(ctx.sessionId);
    const result = await PlanAgent.generate(goal, {
      model: ctx.event.agent.model,
      systemPrompt: ctx.event.agent.systemPrompt,
      budget: ctx.event.agent.budget,
    });

    SessionBridge.storePlanResult(ctx.sessionId, result, ctx.event.agent.model);

    return { mode: "plan", sessionId: ctx.sessionId, result };
  }

  export async function handleDirect(
    ctx: HandlerContext,
  ): Promise<Extract<IngressResult, { mode: "direct" }>> {
    if (ctx.event.mode !== "direct") {
      throw new Error("handleDirect requires direct mode event");
    }

    if (ctx.coordinator) {
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

    const messages = SessionBridge.buildDirectMessages(ctx.sessionId).filter(
      (
        message,
      ): message is
        | { role: "user"; content: string }
        | {
            role: "assistant";
            content: string;
          } => message.role === "user" || message.role === "assistant",
    );
    const agent = ChatAgent.create({
      model: ctx.event.agent.model,
      systemPrompt: ctx.event.agent.systemPrompt,
      tools: ctx.event.agent.tools,
      budget: ctx.event.agent.budget,
      toolExecutor: ctx.event.agent.toolExecutor,
    });
    const runResult = await agent.run({ messages });
    const output = runResult.text;

    SessionBridge.storeDirectResult(ctx.sessionId, output, ctx.event.agent.model);

    return {
      mode: "direct",
      sessionId: ctx.sessionId,
      result: {
        output,
        finishReason: runResult.finishReason,
      },
    };
  }
}
