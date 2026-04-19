import type { AgentBudget } from "@openomni/agent";
import type { Plan, Storage, Tool, TraceContext } from "@openomni/protocol";
import { memoryPlanAdapter } from "./memory-plan-adapter.js";
import { PlanAgent } from "./plan-agent.js";

export interface RunPlanConfig {
  model: { provider: string; id: string };
  systemPrompt?: string;
  planSubAdapter?: Storage.PlanSubAdapter;
  planId?: string;
  budget?: AgentBudget;
  tools?: Tool.Spec[];
  toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
  traceContext?: TraceContext.Type;
}

export async function runPlan(goal: string, config: RunPlanConfig): Promise<Plan.Result> {
  const planId = config.planId ?? crypto.randomUUID();
  const planSubAdapter = config.planSubAdapter ?? memoryPlanAdapter();

  const prompt = config.systemPrompt?.includes("{{PLAN_ID}}")
    ? config.systemPrompt.replace("{{PLAN_ID}}", planId)
    : config.systemPrompt;

  const agent = PlanAgent.create({
    model: config.model,
    systemPrompt: prompt,
    planSubAdapter,
    budget: config.budget,
    tools: config.tools,
    toolExecutor: config.toolExecutor,
  });

  await agent.run({
    messages: [{ role: "user", content: goal }],
    traceContext: config.traceContext,
  });

  const doc = await planSubAdapter.read(planId);
  if (!doc) throw new Error(`plan agent did not write plan: ${planId}`);
  return { planId };
}
