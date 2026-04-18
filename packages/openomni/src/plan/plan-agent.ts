import { ChatAgent, type AgentBudget, type ChatAgentInstance } from "@openomni/agent";
import type { Storage, Tool } from "@openomni/protocol";
import { PLAN_TOOL_SPECS, createPlanToolExecutor } from "./plan-tools";

function memoryPlanAdapter(): Storage.PlanSubAdapter {
  const store = new Map<
    string,
    { content: string; version: number; createdAt: number; updatedAt: number }
  >();
  return {
    async write(id, content) {
      const existing = store.get(id);
      const now = Date.now();
      if (existing) {
        existing.content = content;
        existing.version++;
        existing.updatedAt = now;
      } else {
        store.set(id, { content, version: 1, createdAt: now, updatedAt: now });
      }
    },
    async read(id) {
      return store.get(id);
    },
    async delete(id) {
      store.delete(id);
    },
    async list() {
      return [...store.entries()].map(([id, entry]) => ({
        id,
        version: entry.version,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }));
    },
  };
}

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
