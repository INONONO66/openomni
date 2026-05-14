import {
  IngressEvent,
  type Execution,
  type Ingress,
  type Policy,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { PolicyEngine, type PolicyDecision, type PolicyRegistration } from "@openomni/agent";
import { Bus } from "@openomni/session";
import type { CoordinatorLike } from "./coordinator-like";
import { SessionBridge } from "./session-bridge";

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export namespace IngressHandlers {
  export interface HandlerContext {
    sessionId: string;
    event: Ingress.InboundEvent;
    coordinator: CoordinatorLike;
    traceContext?: TraceContextProtocol.Type;
    policies?: PolicyRegistration[];
    onPolicyDecision?: (decision: PolicyDecision) => void | Promise<void>;
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

  async function dispatchWritebackCommit(ctx: HandlerContext, output: string): Promise<string> {
    if (!ctx.policies?.length) return output;

    const engine = PolicyEngine.create({
      traceContext: ctx.traceContext,
      onDecision: ctx.onPolicyDecision,
    });
    for (const reg of ctx.policies) {
      engine.register(reg);
    }

    const verdict = await engine.dispatch("writeback.commit", {
      steps: [],
      usage: emptyUsage,
      turnCount: 0,
      isCompletion: true,
      continuationCount: 0,
      elapsedMs: 0,
      labels: [{ value: `surface.${ctx.event.surface}`, source: "system" }],
      toolInput: {
        sessionId: ctx.sessionId,
        mode: ctx.event.mode,
        surface: ctx.event.surface,
        output,
      },
      traceContext: ctx.traceContext,
    });

    return resolveWritebackVerdict(verdict, output);
  }

  function resolveWritebackVerdict(verdict: Policy.Verdict, output: string): string {
    switch (verdict.action) {
      case "continue":
        return output;
      case "transform": {
        const input = verdict.input as { output?: unknown };
        return typeof input.output === "string" ? input.output : output;
      }
      case "skip":
      case "abort":
      case "retry":
      case "inject":
      case "deny":
        throw new Error(verdict.reason ?? `writeback.commit policy returned ${verdict.action}`);
    }
  }

  export function buildExecutionRequest(ctx: HandlerContext): Execution.Request {
    return {
      runId: crypto.randomUUID(),
      sessionId: ctx.sessionId,
      mode: "direct",
      prompt: extractPrompt(ctx.event.payload),
      model: ctx.event.agent.model,
      systemPrompt: ctx.event.agent.systemPrompt,
      tools: ctx.event.agent.tools,
      toolConfig: ctx.event.agent.toolConfig,
      permissions: ctx.event.agent.permissions,
      credentials: undefined,
      budget: ctx.event.agent.budget,
      workspaceRoot: ctx.event.agent.toolConfig?.workspaceRoot,
      policyPlan: ctx.event.agent.policyPlan,
      traceId: ctx.traceContext?.traceId,
    };
  }

  export async function handleDirect(ctx: HandlerContext): Promise<Ingress.IngressResult> {
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
    const output = await dispatchWritebackCommit(ctx, coordinatorResult.output ?? "");
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
