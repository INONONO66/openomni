import type { Teammate } from "./teammate";

export interface TeamAgentDefinition {
  name: string;
  description: string;
  promptHints?: string[];
  toolHints?: string[];
  recommendedCategory?: string;
}

export const TEAM_AGENTS: TeamAgentDefinition[] = [
  {
    name: "default",
    description: "General-purpose execution agent",
  },
  {
    name: "research",
    description: "Investigation-focused agent for dependency and context gathering",
    promptHints: [
      "Gather missing context before acting.",
      "Summarize the relevant constraints before proposing changes.",
    ],
    toolHints: ["search", "read", "analysis"],
    recommendedCategory: "deep",
  },
  {
    name: "implementation",
    description: "Execution-focused agent for code and configuration changes",
    promptHints: [
      "Prefer direct implementation once the approach is clear.",
      "Keep edits scoped to the requested deliverable.",
    ],
    toolHints: ["edit", "test", "build"],
    recommendedCategory: "precise",
  },
  {
    name: "review",
    description: "Validation-focused agent for QA, regression checks, and polish",
    promptHints: [
      "Look for regressions before declaring the task complete.",
      "Call out missing evidence or unresolved risks clearly.",
    ],
    toolHints: ["test", "diagnostics", "verification"],
    recommendedCategory: "precise",
  },
];

function formatAgentSystemPrompt(definition: TeamAgentDefinition): string {
  const lines = [definition.description];

  if (definition.promptHints && definition.promptHints.length > 0) {
    lines.push("Prompt hints:", ...definition.promptHints.map((hint) => `- ${hint}`));
  }

  if (definition.toolHints && definition.toolHints.length > 0) {
    lines.push(`Recommended tool focus: ${definition.toolHints.join(", ")}`);
  }

  return lines.join("\n");
}

export function resolveTeamAgent(name: string): Partial<Teammate.TeammateConfig> {
  const definition = TEAM_AGENTS.find((agent) => agent.name === name);
  if (!definition) return {};

  return {
    agentId: definition.name,
    systemPrompt: formatAgentSystemPrompt(definition),
  };
}

export function getAgentMetadata(name: string): TeamAgentDefinition | undefined {
  return TEAM_AGENTS.find((agent) => agent.name === name);
}
