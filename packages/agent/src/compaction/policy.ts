import { PolicyDecision, type BusEvent } from "@openomni/protocol";
import { Compaction, type CompactionOptions } from "./compact";
import type { CanonicalPolicyRegistration } from "../core/policy/types";

type CompactionConfig = CompactionOptions & {
  /** Where the compaction record goes. The policy reports; it does not decide. */
  readonly events: BusEvent.Sink;
  /** Ordering relative to the product's other run.completion.pre policies — the caller's opinion, not the mechanism's. */
  readonly priority: number;
};

export function createCompactionPolicy(config: CompactionConfig): CanonicalPolicyRegistration {
  const { events, priority, ...compaction } = config;
  return {
    name: "builtin:compaction",
    kind: "point",
    pointIds: ["run.completion.pre"],
    effectCapabilities: { "run.completion.pre": ["run.replace_messages"] },
    priority,
    fn: async (ctx) => {
      if (!ctx.messages || ctx.messages.length === 0) {
        return PolicyDecision.allow({ policyId: "builtin.compaction" });
      }
      // The trigger reads the provider-measured context of the last call —
      // cumulative run spend re-counts every prior turn's input and would fire
      // on long runs whose window is nowhere near full. No call yet means
      // nothing measured, and an unmeasured skip is itself recorded.
      if (ctx.contextTokens === undefined) {
        return PolicyDecision.allow({
          policyId: "builtin.compaction",
          reasonCodes: ["compaction_skipped_no_measurement"],
        });
      }
      if (!Compaction.shouldCompact(ctx.contextTokens, compaction)) {
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
      const result = await Compaction.compact(
        ctx.messages,
        compaction,
        { traceId },
        events,
        ctx.contextTokens,
      );
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
