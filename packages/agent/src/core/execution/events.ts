import { BusEvent, Token } from "@openomni/protocol";
import { z } from "zod";

const AgentBase = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  time: z.number(),
});

/**
 * #499 observation descriptors — loop-run events published via Bus.
 *
 * #500 C1: moved here from protocol's `Run.Events` — every publisher lives in
 * this package (run-events.ts, compaction/compact.ts), so the descriptors
 * live with them (precedent: openomni messaging defines its own descriptors).
 * The persisted event names stay the historical `agent.*` strings (frozen —
 * ledger rows and downstream category derivation key on them byte-for-byte).
 */
export const RunEvents = {
  TurnStart: BusEvent.define(
    "agent.turn.start",
    AgentBase.extend({
      turnIndex: z.number(),
    }),
    { visibility: "ephemeral" },
  ),
  TurnComplete: BusEvent.define(
    "agent.turn.complete",
    AgentBase.extend({
      turnIndex: z.number(),
      usage: Token.AgentUsage,
    }),
    { visibility: "llm_reason" },
  ),
  BudgetWarning: BusEvent.define(
    "agent.budget.warning",
    AgentBase.extend({
      remaining: z.string(),
      threshold: z.number(),
    }),
    { visibility: "llm_reason" },
  ),
  BudgetReassurance: BusEvent.define(
    "agent.budget.reassurance",
    AgentBase.extend({
      remaining: z.string(),
      threshold: z.number(),
    }),
    { visibility: "ephemeral" },
  ),
  Compaction: BusEvent.define(
    "agent.compaction",
    AgentBase.extend({
      messagesBefore: z.number(),
      messagesAfter: z.number(),
    }),
    { visibility: "llm_reason" },
  ),
  /**
   * The compaction lock bracket. `started` is published before any
   * compaction work; `completed` is the operation's last record on every
   * exit path, a summarizer throw included (`outcome: "failed"`). A started
   * row without a completed row therefore diagnoses a run that died inside
   * compaction — previously indistinguishable from an unexplained
   * fail-closed deny. The existing `agent.compaction` event remains the
   * apply-phase record at the effect seam.
   */
  CompactionStarted: BusEvent.define(
    "agent.compaction.started",
    AgentBase.extend({
      messagesBefore: z.number(),
      /** Provider-measured context of the last call; absent when unmeasured. */
      contextTokens: z.number().optional(),
      /** What fired the seam: the threshold gate or the loop's window yield. */
      trigger: z.enum(["threshold", "yield"]),
      /** Whether a summarizer is configured — the crash-risk half. */
      summarizer: z.boolean(),
    }),
    { visibility: "internal" },
  ),
  CompactionCompleted: BusEvent.define(
    "agent.compaction.completed",
    AgentBase.extend({
      outcome: z.enum(["cut", "reduced", "nothing_reclaimed", "no_user_boundary", "failed"]),
      messagesBefore: z.number(),
      messagesAfter: z.number(),
      removedCount: z.number(),
      elidedChars: z.number(),
      /**
       * Cut outcomes only: whether an anchor render heads the kept window.
       * An unanchored cut drops assistant/tool context with no checkpoint —
       * legal (preserved users still head the window) but a different loss
       * class than an anchored cut, so it must not masquerade as one.
       * Upcast-on-read: absent on rows recorded before the field existed.
       */
      anchored: z.boolean().optional(),
      error: z.string().optional(),
    }),
    { visibility: "internal" },
  ),
  ErrorRetry: BusEvent.define(
    "agent.error.retry",
    AgentBase.extend({
      attempt: z.number(),
      maxAttempts: z.number(),
      error: z.string(),
      /** Why the error was judged retryable — see `Retry.classifyRetryReason`. */
      reason: z.enum([
        "timeout",
        "tool_error",
        "transient_error",
        "validation_error",
        "context_overflow",
      ]),
      /** How long the run waits before the next attempt. */
      backoffMs: z.number(),
    }),
    { visibility: "llm_reason" },
  ),
};
