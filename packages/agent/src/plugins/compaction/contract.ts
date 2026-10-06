import type { Message } from "@openomni/protocol";
import type { CompactionYield } from "./geometry";
import type { CompactionRecord } from "./durable";

// #1307: the option/budget shapes are seam types the kernel reads from
// `core/compaction-ports`; this module keeps its old names as re-exports so
// the mechanism files stay put.
export type {
  CompactionOptions,
  ResolvedCompactionOptions,
  SummarizationBudget,
} from "../../core/api";

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
