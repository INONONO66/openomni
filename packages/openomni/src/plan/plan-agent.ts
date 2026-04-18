import { ChatAgent, type AgentBudget, type ChatAgentInstance } from "@openomni/agent";
import type { Storage, Tool } from "@openomni/protocol";
import { memoryPlanAdapter } from "./memory-plan-adapter.js";
import { PLAN_TOOL_SPECS, createPlanToolExecutor } from "./plan-tools";

export namespace PlanAgent {
  export interface CreateConfig {
    model: { provider: string; id: string };
    systemPrompt?: string;
    budget?: AgentBudget;
    tools?: Tool.Spec[];
    toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
    planSubAdapter?: Storage.PlanSubAdapter;
    stepGuard?: Parameters<typeof ChatAgent.create>[0]["stepGuard"];
  }

  export function create(config: CreateConfig): ChatAgentInstance {
    const adapter = config.planSubAdapter ?? memoryPlanAdapter();
    const planExecutor = createPlanToolExecutor(adapter);
    const allTools: Tool.Spec[] = [...PLAN_TOOL_SPECS, ...(config.tools ?? [])];
    const planToolNames = new Set(PLAN_TOOL_SPECS.map((s) => s.name));

    return ChatAgent.create({
      model: config.model,
      systemPrompt: config.systemPrompt,
      budget: config.budget,
      tools: allTools,
      toolExecutor: async (call: Tool.Call): Promise<Tool.Result> => {
        if (planToolNames.has(call.tool)) return planExecutor(call);
        if (config.toolExecutor) return config.toolExecutor(call);
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: `No executor for tool: ${call.tool}`,
          isError: true,
        };
      },
      stepGuard: config.stepGuard,
    });
  }
}
