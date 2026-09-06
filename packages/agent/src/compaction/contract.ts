import type { Message } from "@openomni/protocol";
import type { CompactionYield } from "./geometry";
import type { ToolOutputElision } from "./reduce";
import type { CompactionRecord } from "./durable";

export interface SummarizationBudget {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly contextWindowTokens: number;
}

export interface CompactionOptions {
  /**
   * Optional narrowing of the model's window. The loop records the resolved
   * model's real limit and the policy reads it from the dispatch context, so
   * strategy config only sets this to compact as if the window were smaller.
   */
  contextWindowTokens?: number;
  /** Minimum headroom reserved beyond the adaptive threshold. */
  reserveTokens?: number;
  protectRecentMessages?: number;
  /**
   * Anchored iterative summarization (compaction-design L2). The summarizer
   * receives the newly cut span WITH user messages and prior anchor renders
   * already excluded, plus the previous anchor body when one exists — it
   * merges, it never regenerates. The mechanism owns the exclusions and the
   * threading; what the summarizer does with them is strategy.
   */
  onSummarize?: (
    messages: Message.WithParts[],
    previousAnchor: string | undefined,
    budget: SummarizationBudget,
    signal?: AbortSignal,
  ) => Promise<string>;
  /**
   * Budget (chars) of most-recent user messages carried verbatim through a
   * cut. The newest user message is always preserved even when it alone
   * exceeds the budget — user tokens are the irreplaceable part.
   */
  preserveUserMessageChars?: number;
  /**
   * Opt-in deterministic reduction: when the trigger fires, old completed
   * tool outputs are elided first; the lossy cut joins the same round
   * whenever the estimated net reclaim cannot cover the measured overage.
   * The knobs are strategy, so they arrive as config.
   */
  elideToolOutputs?: ToolOutputElision;
  /**
   * Speculative prepare/promote (L4). Meaningful only with `onSummarize`:
   * once the measured window passes the prepare ratio the summarize call
   * runs in the background at turn settlement, and the seam promotes the
   * result with zero model calls while its span is still live. `false`
   * disables speculation; the seam then always merges synchronously.
   */
  speculate?: false;
  /** Maximum duration of each summarizer call before deterministic fallback. */
  summarizerDeadlineMs?: number;
}

/** Options with the window already resolved — the mechanism never guesses it. */
export type ResolvedCompactionOptions = CompactionOptions & { contextWindowTokens: number };

export interface CompactionResult {
  readonly record?: CompactionRecord;
  messages: Message.WithParts[];
  compacted: boolean;
  removedCount: number;
  /** L4: what happened to the speculative candidate, when one was offered. */
  candidate?: "promoted" | "discarded";
  /** The synchronous merge failed and used the deterministic snap-cut fallback. */
  summarizerFailed?: boolean;
  /** Estimated structural yield of the replacement, used by the next geometry decision. */
  yield?: CompactionYield;
  /** A compacted replacement that saved too little to justify another early round. */
  ineffective?: boolean;
  /** Set when the trigger fired but no provider-valid cut exists: no summary
   * anchor and no user boundary at or before the cutoff. The caller records
   * it; killing the run over housekeeping would be worse than a full window. */
  blocked?: "no_user_boundary";
}

export type FinishCompaction = (
  result: CompactionResult,
  outcome: "cut" | "reduced" | "nothing_reclaimed" | "no_user_boundary",
  elidedChars: number,
  anchored?: boolean,
  summarizerError?: Error,
) => CompactionResult;

export interface ReducedHistory {
  readonly working: Message.WithParts[];
  readonly elidedChars: number;
  readonly completed?: CompactionResult;
}

export interface AnchoredCutAttempt {
  readonly cut?: CompactionResult;
  readonly summarizerError?: Error;
}

export const DEFAULT_PROTECT_RECENT = 6;

// ~20k tokens of verbatim user text carried through a cut (Codex ships the
// same order of magnitude). Strategy may narrow or widen it.
export const DEFAULT_PRESERVE_USER_CHARS = 80_000;
