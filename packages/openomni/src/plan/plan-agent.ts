import { ChatAgent, type AgentBudget, type ChatAgentInstance } from "@openomni/agent";
import { PlanSchema, type PlanResult, type Tool } from "@openomni/protocol";
import { InMemoryPlanStore, type PlanStore } from "./plan-store";
import { PLAN_TOOL_SPECS, createPlanToolExecutor } from "./plan-tools";

function normalizePlanPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.createdAt !== "string") {
    return payload;
  }

  const parsedDate = new Date(candidate.createdAt);
  if (Number.isNaN(parsedDate.getTime())) {
    return payload;
  }

  return { ...candidate, createdAt: parsedDate };
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function parsePlan(text: string): PlanResult["plan"] {
  const jsonText = extractJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse plan JSON: ${reason}`);
  }

  const result = PlanSchema.safeParse(normalizePlanPayload(parsed));
  if (!result.success) {
    throw new Error(`Failed to validate plan: ${result.error.message}`);
  }

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

  export interface CreateConfig {
    model: { provider: string; id: string };
    systemPrompt?: string;
    budget?: AgentBudget;
    tools?: Tool.Spec[];
    toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
    planStore?: PlanStore;
    stepGuard?: Parameters<typeof ChatAgent.create>[0]["stepGuard"];
  }

  export function create(config: CreateConfig): ChatAgentInstance {
    const store = config.planStore ?? new InMemoryPlanStore();
    const planExecutor = createPlanToolExecutor(store);

    const allTools: Tool.Spec[] = [...PLAN_TOOL_SPECS, ...(config.tools ?? [])];

    const composedExecutor = async (call: Tool.Call): Promise<Tool.Result> => {
      if (call.tool.startsWith("plan_")) {
        return planExecutor(call);
      }
      if (config.toolExecutor) {
        return config.toolExecutor(call);
      }
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `No executor for tool: ${call.tool}`,
        isError: true,
      };
    };

    return ChatAgent.create({
      model: config.model,
      systemPrompt: config.systemPrompt,
      budget: config.budget,
      tools: allTools,
      toolExecutor: composedExecutor,
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

    const result = await agent.run({
      messages: [{ role: "user", content: goal }],
    });

    const plan = parsePlan(result.text);
    return { plan };
  }
}
