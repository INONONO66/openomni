import type { CategoryConfig } from "./category";

export const BUILTIN_CATEGORIES: CategoryConfig[] = [
  {
    name: "quick",
    description: "Trivial single-file tasks that favor fast execution.",
    agentHints: ["sisyphus-junior"],
    toolHints: ["read", "edit", "bash"],
  },
  {
    name: "deep",
    description: "Autonomous research and implementation work that needs sustained context.",
    agentHints: ["sisyphus-junior", "explore"],
    toolHints: ["read", "grep", "bash", "lsp"],
    promptAppend: "Do broad codebase exploration before changing implementation details.",
  },
  {
    name: "visual-engineering",
    description: "UI, layout, or design-sensitive changes that benefit from visual validation.",
    agentHints: ["frontend-ui-ux", "dev-browser"],
    toolHints: ["browser", "read", "edit"],
    promptAppend: "Verify visual behavior, not just static code paths.",
  },
  {
    name: "ultrabrain",
    description: "High-ambiguity problems that need stronger synthesis and planning discipline.",
    agentHints: ["oracle", "sisyphus-junior"],
    toolHints: ["read", "grep", "bash", "lsp"],
    promptAppend: "Prefer deeper reasoning, explicit assumptions, and careful verification.",
  },
  {
    name: "writing",
    description: "Documentation and narrative tasks where clarity and structure matter most.",
    agentHints: ["sisyphus-junior"],
    toolHints: ["read", "edit"],
    promptAppend: "Optimize for legibility, structure, and concise explanations.",
  },
  {
    name: "unspecified-high",
    description: "Fallback for unknown but likely complex tasks; favor safety over speed.",
    agentHints: ["sisyphus-junior"],
    toolHints: ["read", "grep", "bash"],
    promptAppend: "Treat the request as high-ambiguity until the task is classified better.",
  },
  {
    name: "unspecified-low",
    description: "Fallback for unknown lightweight tasks when minimal routing context exists.",
    agentHints: ["sisyphus-junior"],
    toolHints: ["read", "edit"],
    promptAppend: "Start with the smallest safe action and expand only if needed.",
  },
];
