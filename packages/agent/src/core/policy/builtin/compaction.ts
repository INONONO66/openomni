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

      // `run.completion.pre` is fail-closed, so throwing here would end the
      // run — the failure mode this guard was added to prevent. The lifecycle
      // always supplies the trace (`buildLifecyclePolicyContext`); if some
      // future dispatcher does not, skipping compaction degrades the turn
      // rather than killing the run, and the skip is itself recorded.
      const traceId = ctx.traceContext?.traceId;
      if (traceId === undefined || traceId.length === 0) {
        return PolicyDecision.allow({
          policyId: "builtin.compaction",
          reasonCodes: ["compaction_skipped_no_trace"],
        });
      }
      const result = await InMemoryCompactor.compact(ctx.messages, config, { traceId });
      if (!result.compacted) {
        return PolicyDecision.allow({ policyId: "builtin.compaction" });
      }

      return PolicyDecision.allow({
        policyId: "builtin.compaction",
        reasonCodes: ["compaction_threshold_exceeded"],
        effects: [{ type: "run.replace_messages", messages: result.messages }],
      });
    },
  };
}
