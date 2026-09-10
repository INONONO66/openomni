import type { ChatAgentConfig } from "../../src/core/types";
import { collector } from "./observation-collector";

export function toolBudgetConfig(maxToolCalls: number): Pick<ChatAgentConfig, "events" | "model" | "budget"> {
  return {
    events: collector(),
    model: { provider: "provider", id: "model" },
    budget: { maxToolCalls },
  };
}

export function overflowCompactionConfig(): Pick<ChatAgentConfig, "events" | "model" | "compaction"> {
  return {
    events: collector(),
    model: { provider: "provider", id: "model" },
    compaction: {
      contextWindowTokens: 10_000,
      protectRecentMessages: 2,
      speculate: false,
      onSummarize: async () => "overflow checkpoint",
    },
  };
}
