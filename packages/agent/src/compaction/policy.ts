import { PolicyDecision, type BusEvent } from "@openomni/protocol";
import { Compaction, DEFAULT_PROTECT_RECENT, type CompactionOptions } from "./compact";
import { DEFAULT_PREPARE_RATIO, createSpeculator, type Speculator } from "./speculate";
import type { CanonicalPolicyRegistration, PolicyRegistrationFactory } from "../core/policy/types";

type CompactionConfig = CompactionOptions & {
  /** Where the compaction record goes. The policy reports; it does not decide. */
  readonly events: BusEvent.Sink;
  /** Ordering relative to the product's other run.completion.pre policies — the caller's opinion, not the mechanism's. */
  readonly priority: number;
};

/**
 * Factory form since L4: the speculator is per-run state (a candidate must
 * die with its run — the #692 lesson), and factories are the one sanctioned
 * home for stateful policies (engines are built once per run and invoke
 * `create()` at registration).
 */
export function createCompactionPolicy(config: CompactionConfig): PolicyRegistrationFactory {
  return {
    kind: "factory",
    name: "builtin:compaction",
    create: () => buildRegistration(config),
  };
}

function buildRegistration(config: CompactionConfig): CanonicalPolicyRegistration {
  const { events, priority, ...compaction } = config;
  const speculator: Speculator | undefined =
    compaction.onSummarize !== undefined && compaction.speculate !== false
      ? createSpeculator({
          prepareRatio: compaction.speculate?.prepareRatio ?? DEFAULT_PREPARE_RATIO,
          protectRecentMessages: compaction.protectRecentMessages ?? DEFAULT_PROTECT_RECENT,
          onSummarize: compaction.onSummarize,
        })
      : undefined;
  const pointIds =
    speculator === undefined
      ? (["run.completion.pre"] as const)
      : (["run.turn.post", "run.completion.pre"] as const);

  return {
    name: "builtin:compaction",
    kind: "point",
    pointIds,
    effectCapabilities: {
      "run.completion.pre": ["run.replace_messages"],
      ...(speculator === undefined ? {} : { "run.turn.post": [] }),
    },
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
      // The window is the loop's fact (the resolved model's limit); config may
      // narrow it. Neither known — proxy models report 0 — means no threshold
      // to compare against, and the skip says so.
      const contextWindowTokens = compaction.contextWindowTokens ?? ctx.contextWindowTokens;
      if (contextWindowTokens === undefined) {
        return PolicyDecision.allow({
          policyId: "builtin.compaction",
          reasonCodes: ["compaction_skipped_no_window"],
        });
      }

      // L4: turn settlement is the prepare hook — observation only, no
      // effects. The dispatch context is a frozen clone, which is exactly
      // what a background summarize wants: content it can read while the
      // run moves on.
      if (ctx.pointId === "run.turn.post") {
        speculator?.maybePrepare(ctx.messages, ctx.contextTokens, contextWindowTokens);
        return PolicyDecision.allow({ policyId: "builtin.compaction" });
      }

      const resolved = { ...compaction, contextWindowTokens };
      // A yield-borne dispatch skips the threshold gate: the loop already
      // measured and stopped. Gating it again lets a config ratio above the
      // loop's arm point refuse runs the seam never tried to reclaim.
      if (!ctx.contextYielded && !Compaction.shouldCompact(ctx.contextTokens, resolved)) {
        return PolicyDecision.allow({ policyId: "builtin.compaction" });
      }

      // `run.completion.pre` is fail-closed, so throwing here would end the
      // run — the failure mode this guard was added to prevent. The lifecycle
      // always supplies the trace and session (`buildLifecyclePolicyContext`);
      // if some future dispatcher does not, skipping compaction degrades the
      // turn rather than killing the run, and the skip is itself recorded.
      const traceId = ctx.traceContext?.traceId;
      if (traceId === undefined || traceId.length === 0) {
        return PolicyDecision.allow({
          policyId: "builtin.compaction",
          reasonCodes: ["compaction_skipped_no_trace"],
        });
      }
      const sessionId = ctx.sessionId;
      if (sessionId === undefined || sessionId.length === 0) {
        return PolicyDecision.allow({
          policyId: "builtin.compaction",
          reasonCodes: ["compaction_skipped_no_session"],
        });
      }
      // Riders from the #701 reviews (#702): the bracket records the run when
      // the lifecycle supplies one, and the measuredTokens spread was dead —
      // ctx.contextTokens is guarded at the top of this function.
      const runId = ctx.traceContext?.runId;
      const candidate = speculator?.peek();
      const result = await Compaction.compact(
        ctx.messages,
        resolved,
        { traceId, sessionId, ...(runId === undefined ? {} : { runId }) },
        events,
        {
          trigger: ctx.contextYielded ? "yield" : "threshold",
          measuredTokens: ctx.contextTokens,
          ...(candidate === undefined ? {} : { candidate }),
        },
      );
      // Whatever the seam saw, it consumed: a promoted candidate is spent,
      // a discarded one is dead — either way the next prepare starts clean.
      if (candidate !== undefined) speculator?.consume();
      const candidateReason =
        result.candidate === undefined ? [] : [`compaction_candidate_${result.candidate}`];
      if (!result.compacted) {
        // The trigger fired and nothing was reclaimed — the one silent path
        // the wiring review found. A full window with no visible reason is
        // how a provider 400 arrives unexplained.
        return PolicyDecision.allow({
          policyId: "builtin.compaction",
          reasonCodes: [
            result.blocked === "no_user_boundary"
              ? "compaction_skipped_no_boundary"
              : "compaction_skipped_nothing_reclaimed",
            ...candidateReason,
          ],
        });
      }

      return PolicyDecision.allow({
        policyId: "builtin.compaction",
        reasonCodes: ["compaction_threshold_exceeded", ...candidateReason],
        effects: [{ type: "run.replace_messages", messages: result.messages }],
      });
    },
  };
}
