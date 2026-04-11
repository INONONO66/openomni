import { ChatAgent, type AgentBudget, type ChatAgentInstance } from "@openomni/agent";
import { PlanSchema, type PlanResult, type Tool } from "@openomni/protocol";
import { extractJson, normalizePlanPayload } from "./plan-json.js";
import { InMemoryPlanStore, type PlanStore } from "./plan-store";
import { PLAN_TOOL_SPECS, createPlanToolExecutor } from "./plan-tools";

function parsePlan(text: string): PlanResult["plan"] {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(text));
  } catch (e) {
    throw new Error(`Failed to parse plan JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const result = PlanSchema.safeParse(normalizePlanPayload(raw));
  if (!result.success) throw new Error(`Failed to validate plan: ${result.error.message}`);
  return result.data;
}

export namespace PlanAgent {
  export interface GenerateConfig {
    model: { provider: string; id: string };
    systemPrompt?: string;
    budget?: AgentBudget;
    tools?: Tool.Spec[];
    toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
  }

  export interface CreateConfig extends GenerateConfig {
    planStore?: PlanStore;
    stepGuard?: Parameters<typeof ChatAgent.create>[0]["stepGuard"];
  }

  export function create(config: CreateConfig): ChatAgentInstance {
    const store = config.planStore ?? new InMemoryPlanStore();
    const planExecutor = createPlanToolExecutor(store);
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

  export async function generate(goal: string, config: GenerateConfig): Promise<PlanResult> {
    const agent = ChatAgent.create({
      model: config.model,
      systemPrompt: config.systemPrompt ?? "",
      budget: config.budget,
      tools: config.tools,
      toolExecutor: config.toolExecutor,
    });
    const result = await agent.run({ messages: [{ role: "user", content: goal }] });
    return { plan: parsePlan(result.text) };
  }
}
