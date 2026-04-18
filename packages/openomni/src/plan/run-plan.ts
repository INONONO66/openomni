import type { AgentBudget } from "@openomni/agent";
import type { Plan, Storage, Tool } from "@openomni/protocol";
import { PlanAgent } from "./plan-agent.js";

export interface RunPlanConfig {
  model: { provider: string; id: string };
  systemPrompt?: string;
  planSubAdapter?: Storage.PlanSubAdapter;
  planId?: string;
  budget?: AgentBudget;
  tools?: Tool.Spec[];
  toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
}

function memoryAdapter(): Storage.PlanSubAdapter {
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

export async function runPlan(goal: string, config: RunPlanConfig): Promise<Plan.Result> {
  const planId = config.planId ?? crypto.randomUUID();
  const planSubAdapter = config.planSubAdapter ?? memoryAdapter();

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

  let planWritten = false;
  await agent.run(
    { messages: [{ role: "user", content: goal }] },
    {
      onMessage() {},
      onToolCall(call) {
        if (call.tool === "plan_write") planWritten = true;
      },
      onToolResult() {},
      onSnapshot() {},
    },
  );

  if (!planWritten) throw new Error(`plan agent did not write plan: ${planId}`);
  return { planId };
}
