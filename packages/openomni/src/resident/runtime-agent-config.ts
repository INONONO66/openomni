import { ChatAgent, type ChatAgentConfig, type ChatAgentInput } from "@openomni/agent";
import type { Ingress } from "@openomni/protocol";
import { buildWorkerMiddleware } from "../execution-runtime/middleware";
import type { ResidentRunContext } from "./runtime-types";

type RuntimeAgentDef = Ingress.AgentDef & {
  readonly providerOptions?: Record<string, unknown>;
};

/**
 * #562 F2: the resident direct path runs WITHOUT a transcript fact sink ON
 * PURPOSE — not for layering reasons (this package already reaches
 * TranscriptStore, and ResidentRuntimeOptions.runAgent is injectable from
 * the server composition), but because the resident path's durable
 * assistant write is SessionBridge.storeDirectResult at the ingress handler
 * (ingress/handlers.ts handleResident): it persists the POST-writeback
 * output (dispatchWritebackCommit policies may transform it) under its own message
 * id, wrapped in the ingress audit envelope. Wiring a raw-stream sink here
 * would (1) double-persist every resident turn — the streamed message id
 * via facts plus the writeback message id via projection, with diverging
 * raw-vs-committed text — and (2) give resident sessions their first
 * transcript facts, flipping Session.resume off the projection fallback and
 * silently dropping all pre-existing projection-only resident history.
 * Recording facts for residents therefore rides a redesign of the writeback
 * seam (record the committed writeback as the fact), not a sink here.
 * Resident sessions stay all-projection, so resume's fallback covers them
 * losslessly — see the writer census in Session.resume.
 */
export function defaultRunAgent(config: ChatAgentConfig, input: ChatAgentInput) {
  return ChatAgent.create(config).run(input);
}

export function buildResidentAgentConfig(ctx: ResidentRunContext, runId: string): ChatAgentConfig {
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
