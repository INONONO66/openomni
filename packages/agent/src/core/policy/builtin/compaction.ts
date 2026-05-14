import { InMemoryCompactor } from "../../execution/compaction";
import type { PolicyFactory, PolicyRegistration } from "../types";
import type { ChatAgentConfig } from "../../types";

type CompactionConfig = NonNullable<ChatAgentConfig["compaction"]>;

export function createCompactionPolicy(config: CompactionConfig): PolicyRegistration {
  return {
    name: "builtin:compaction",
    timing: "completion.prepare",
    priority: 900,
    fn: async (ctx) => {
      if (!ctx.messages || ctx.messages.length === 0) {
        return { action: "continue" };
      }
      if (!ctx.budgetState) {
        return { action: "continue" };
      }

      const totalTokens = ctx.budgetState.totalInputTokens + ctx.budgetState.totalOutputTokens;
      if (!InMemoryCompactor.shouldCompact(totalTokens, config)) {
        return { action: "continue" };
      }

      const result = await InMemoryCompactor.compact(ctx.messages, config);
      if (!result.compacted) {
        return { action: "continue" };
      }

      ctx.eventEmitter?.emit("agent.compaction", {
        sessionId: "chat-agent",
        time: Date.now(),
        messagesBefore: ctx.messages.length,
        messagesAfter: result.messages.length,
      });

      return {
        action: "transform",
        input: { messages: result.messages },
        reason: "compaction_threshold_exceeded",
        policyId: "builtin.compaction",
      };
    },
  };
}

export const compactionFactory: PolicyFactory = {
  id: "policy:compaction",
  create: (config) => createCompactionPolicy(config as CompactionConfig),
};
