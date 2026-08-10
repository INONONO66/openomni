import { PolicyDecision } from "@openomni/protocol";
import { InMemoryCompactor, type CompactionOptions } from "../../execution/compaction";
import type { CanonicalPolicyRegistration } from "../types";

type CompactionConfig = CompactionOptions;

export function createCompactionPolicy(config: CompactionConfig): CanonicalPolicyRegistration {
  return {
    name: "builtin:compaction",
    kind: "point",
    pointIds: ["run.completion.pre"],
    effectCapabilities: { "run.completion.pre": ["run.replace_messages"] },
    priority: 900,
    fn: async (ctx) => {
      if (!ctx.messages || ctx.messages.length === 0) {
        return PolicyDecision.allow({ policyId: "builtin.compaction" });
      }
      if (!ctx.budgetState) {
        return PolicyDecision.allow({ policyId: "builtin.compaction" });
      }

      const totalTokens = ctx.budgetState.totalInputTokens + ctx.budgetState.totalOutputTokens;
      if (!InMemoryCompactor.shouldCompact(totalTokens, config)) {
        return PolicyDecision.allow({ policyId: "builtin.compaction" });
      }

      const result = await InMemoryCompactor.compact(ctx.messages, config);
      if (!result.compacted) {
        return PolicyDecision.allow({ policyId: "builtin.compaction" });
      }

      // run.completion.pre contract guarantees a non-empty sessionId on
      // every canonical dispatch; "" only surfaces on a non-contract invocation.
      ctx.eventEmitter?.emit("agent.compaction", {
        sessionId: ctx.sessionId ?? "",
        time: Date.now(),
        messagesBefore: ctx.messages.length,
        messagesAfter: result.messages.length,
      });

      return PolicyDecision.allow({
        policyId: "builtin.compaction",
        reasonCodes: ["compaction_threshold_exceeded"],
        effects: [{ type: "run.replace_messages", messages: result.messages }],
      });
    },
  };
}
