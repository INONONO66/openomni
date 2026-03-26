import { ChatAgent } from "@openomni/agent";
import type { InboundEvent, IngressResult } from "@openomni/protocol";
import { SessionBridge } from "./session-bridge";
import { PlanAgent } from "../plan/plan-agent";
import { TeamOrchestrator } from "../team/team-orchestrator";

export namespace IngressHandlers {
  export interface HandlerContext {
    sessionId: string;
    event: InboundEvent;
  }

  export async function handlePlan(
    ctx: HandlerContext,
  ): Promise<Extract<IngressResult, { mode: "plan" }>> {
    if (ctx.event.mode !== "plan") {
      throw new Error("handlePlan requires plan mode event");
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

  export async function handleTeam(
    ctx: HandlerContext,
  ): Promise<Extract<IngressResult, { mode: "team" }>> {
    if (ctx.event.mode !== "team") {
      throw new Error("handleTeam requires team mode event");
    }

    const plan = SessionBridge.extractPlan(ctx.sessionId);
    const orchestratorConfig: TeamOrchestrator.OrchestratorConfig = {
      reviewModel: ctx.event.agents.reviewer.model,
      reviewSystemPrompt: ctx.event.agents.reviewer.systemPrompt,
      defaultTeammateConfig: {
        agentId: "executor",
        model: ctx.event.agents.executor.model,
        systemPrompt: ctx.event.agents.executor.systemPrompt,
        tools: ctx.event.agents.executor.tools,
        toolExecutor: ctx.event.agents.executor.toolExecutor,
        budget: ctx.event.agents.executor.budget,
      },
      teammates: new Map(),
    };

    const result = await TeamOrchestrator.execute(plan, orchestratorConfig);
    SessionBridge.storeTeamResult(ctx.sessionId, result, ctx.event.agents.reviewer.model);

    return {
      mode: "team",
      sessionId: ctx.sessionId,
      result: {
        ...result,
        results: Object.fromEntries(result.results),
      },
    };
  }

  export async function handleDirect(
    ctx: HandlerContext,
  ): Promise<Extract<IngressResult, { mode: "direct" }>> {
    if (ctx.event.mode !== "direct") {
      throw new Error("handleDirect requires direct mode event");
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
