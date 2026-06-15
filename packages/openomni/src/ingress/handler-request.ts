import type { Execution } from "@openomni/protocol";
import type { HandlerContext } from "./handler-types";
import { extractPrompt } from "./handler-prompt";

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
    providerOptions: (ctx.event.agent as { providerOptions?: Record<string, unknown> })
      .providerOptions,
    traceId: ctx.traceContext?.traceId,
    agentName: typeof ctx.event.meta?.agentName === "string" ? ctx.event.meta.agentName : undefined,
  };
}
