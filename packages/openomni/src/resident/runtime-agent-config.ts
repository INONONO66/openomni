import { ChatAgent, type ChatAgentConfig, type ChatAgentInput } from "@openomni/agent";
import type { Ingress } from "@openomni/protocol";
import { buildWorkerMiddleware } from "../execution-runtime/middleware";
import type { ResidentRunContext } from "./runtime-types";

type RuntimeAgentDef = Ingress.AgentDef & {
  readonly providerOptions?: Record<string, unknown>;
};

export function defaultRunAgent(config: ChatAgentConfig, input: ChatAgentInput) {
  return ChatAgent.create(config).run(input);
}

export function buildResidentAgentConfig(
  ctx: ResidentRunContext,
  runId: string,
  dependencies: Pick<ChatAgentConfig, "environment" | "modelCatalog">,
): ChatAgentConfig {
  const workspaceRoot = ctx.event.agent.toolConfig?.workspaceRoot ?? ctx.event.workspace;
  const toolExecutor = ctx.event.agent.toolExecutorFactory
    ? ctx.event.agent.toolExecutorFactory({
        sessionId: ctx.sessionId,
        runId,
        agentName: extractAgentName(ctx.event),
        workspaceRoot,
      })
    : ctx.event.agent.toolExecutor;
  const agent = ctx.event.agent as RuntimeAgentDef;

  return {
    model: ctx.event.agent.model,
    environment: dependencies.environment,
    modelCatalog: dependencies.modelCatalog,
    systemPrompt: ctx.event.agent.systemPrompt,
    budget: ctx.event.agent.budget,
    tools: ctx.event.agent.tools,
    toolExecutor,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(agent.providerOptions ? { providerOptions: agent.providerOptions } : {}),
    middleware: buildWorkerMiddleware({
      permissions: ctx.event.agent.permissions,
      ...(ctx.event.agent.policyPlan ? { policyPlan: ctx.event.agent.policyPlan } : {}),
    }),
  };
}

function extractAgentName(event: Ingress.ResolvedInboundEvent): string | undefined {
  if (event.mode === "internal") {
    return event.agentName;
  }
  const raw = event.meta?.agentName ?? event.meta?.agent;
  return typeof raw === "string" ? raw : undefined;
}
