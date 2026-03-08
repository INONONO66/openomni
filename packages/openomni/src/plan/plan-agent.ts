import { ChatAgent, type AgentBudget } from "@openomni/agent";
import { PlanSchema, type PlanResult } from "@openomni/protocol";

export const DEFAULT_SYSTEM_PROMPT = `You are a planning agent. Given a goal, produce a structured execution plan as JSON.

Output ONLY valid JSON matching this schema:
{
  "planId": "<uuid>",
  "goal": "<the goal>",
  "steps": [
    {
      "stepId": "<unique-id>",
      "description": "<what to do>",
      "expectedOutput": "<what success looks like>",
      "dependsOn": ["<stepId>", ...],
      "suggestedAgent": "<optional agent hint>",
      "guardrail": "<optional acceptance criteria>",
      "tools": [{ "name": "<tool-name>", "description": "<what it does>", "inputSchema": { "type": "object", "properties": {} } }]
    }
  ],
  "createdAt": "<ISO date string>",
  "version": 1
}

Rules:
- stepId must be unique across all steps
- dependsOn must reference valid stepIds
- Steps with no dependencies have dependsOn: []
- Minimize dependencies - only add when truly sequential`;

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

function parsePlan(text: string): PlanResult["plan"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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
    reviewPrompt?: string;
    budget?: AgentBudget;
  }

  export async function generate(
    goal: string,
    config: GenerateConfig,
  ): Promise<PlanResult> {
    const promptParts = [config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT];
    if (config.reviewPrompt) {
      promptParts.push(config.reviewPrompt);
    }

    const agent = ChatAgent.create({
      model: config.model,
      systemPrompt: promptParts.join("\n\n"),
      budget: config.budget,
    });

    const result = await agent.run({
      messages: [{ role: "user", content: goal }],
    });

    const plan = parsePlan(result.text);
    return { plan };
  }
}
