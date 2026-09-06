import type { Message } from "@openomni/protocol";
import type {
  ResolvedCompactionOptions,
  FinishCompaction,
  ReducedHistory,
  CompactionResult,
  AnchoredCutAttempt,
} from "./contract";
import { DEFAULT_PROTECT_RECENT, DEFAULT_PRESERVE_USER_CHARS } from "./contract";
import { elideToolOutputs } from "./reduce";
import { resolveThresholdTokens, ESTIMATED_CHARS_PER_TOKEN } from "./estimate";
import { isAnchorMessage, isWarmCandidateValid } from "./candidate";
import { attemptAnchoredCut } from "./summary";
import type { CompactionCandidate } from "./speculate";

function reduceHistoryBeforeCut(
  messages: Message.WithParts[],
  options: ResolvedCompactionOptions,
  protectRecent: number,
  measuredContextTokens: number | undefined,
  finish: FinishCompaction,
): ReducedHistory {
  if (options.elideToolOutputs === undefined) return { working: messages, elidedChars: 0 };

  const reduction = elideToolOutputs(messages, protectRecent, options.elideToolOutputs);
  if (reduction.elidedChars === 0) return { working: messages, elidedChars: 0 };

  const overageTokens =
    measuredContextTokens === undefined
      ? undefined
      : measuredContextTokens - resolveThresholdTokens(options);
  const estimatedReclaimTokens = reduction.elidedChars / ESTIMATED_CHARS_PER_TOKEN;
  if (overageTokens !== undefined && estimatedReclaimTokens < overageTokens) {
    return { working: reduction.messages, elidedChars: reduction.elidedChars };
  }
  return {
    working: reduction.messages,
    elidedChars: reduction.elidedChars,
    completed: finish(
      { messages: reduction.messages, compacted: true, removedCount: 0 },
      "reduced",
      reduction.elidedChars,
    ),
  };
}

function finishUnavailableCut(
  cutoff: number | undefined,
  working: Message.WithParts[],
  elidedChars: number,
  finish: FinishCompaction,
): CompactionResult | undefined {
  if (cutoff === undefined) {
    return elidedChars > 0
      ? finish({ messages: working, compacted: true, removedCount: 0 }, "reduced", elidedChars)
      : finish(
          { messages: working, compacted: false, removedCount: 0, blocked: "no_user_boundary" },
          "no_user_boundary",
          0,
        );
  }
  if (cutoff !== 0) return undefined;
  return elidedChars > 0
    ? finish({ messages: working, compacted: true, removedCount: 0 }, "reduced", elidedChars)
    : finish({ messages: working, compacted: false, removedCount: 0 }, "nothing_reclaimed", 0);
}

function finishAnchoredCut(
  attempt: AnchoredCutAttempt,
  candidateOutcome: "promoted" | "discarded" | undefined,
  messages: Message.WithParts[],
  working: Message.WithParts[],
  elidedChars: number,
  finish: FinishCompaction,
): CompactionResult {
  const withOutcome = (result: CompactionResult): CompactionResult =>
    candidateOutcome === undefined ? result : { ...result, candidate: candidateOutcome };
  const withFailure = (result: CompactionResult): CompactionResult =>
    attempt.summarizerError === undefined ? result : { ...result, summarizerFailed: true };

  if (attempt.cut === undefined) {
    return elidedChars > 0
      ? finish(
          withOutcome(withFailure({ messages: working, compacted: true, removedCount: 0 })),
          "reduced",
          elidedChars,
          undefined,
          attempt.summarizerError,
        )
      : finish(
          withOutcome(withFailure({ messages, compacted: false, removedCount: 0 })),
          "nothing_reclaimed",
          0,
          undefined,
          attempt.summarizerError,
        );
  }

  return finish(
    withOutcome(withFailure(attempt.cut)),
    "cut",
    elidedChars,
    attempt.cut.messages[0] !== undefined && isAnchorMessage(attempt.cut.messages[0]),
    attempt.summarizerError,
  );
}

export async function compactUnbracketed(
  messages: Message.WithParts[],
  options: ResolvedCompactionOptions,
  measuredContextTokens: number | undefined,
  candidate: CompactionCandidate | undefined,
  finish: (
    result: CompactionResult,
    outcome: "cut" | "reduced" | "nothing_reclaimed" | "no_user_boundary",
    elidedChars: number,
    anchored?: boolean,
    summarizerError?: Error,
  ) => CompactionResult,
): Promise<CompactionResult> {
  // A reversible cut names original content as its kept boundary. Even a
  // zero-tail strategy must retain one atomic call/result entry unchanged.
  const protectRecent = Math.max(1, options.protectRecentMessages ?? DEFAULT_PROTECT_RECENT);

  if (messages.length <= protectRecent) {
    return finish({ messages, compacted: false, removedCount: 0 }, "nothing_reclaimed", 0);
  }

  // Reduction before the cut: eliding old tool outputs reclaims window
  // without dropping a message. But under sustained tool use each turn ages
  // a fresh output past the protected tail, so "cut when nothing is left to
  // elide" starves the cut while un-elidable residue accumulates
  // (adversarial review, #645). The round therefore keeps its elision only
  // when the estimated net reclaim plausibly covers the measured overage;
  // otherwise the cut below ALSO runs, on the already-elided history. The
  // estimate (chars/4) only decides the cut's eagerness — the next call
  // measures ground truth, and a wrong estimate costs one earlier or one
  // extra round, never convergence.
  const reduction = reduceHistoryBeforeCut(
    messages,
    options,
    protectRecent,
    measuredContextTokens,
    finish,
  );
  if (reduction.completed !== undefined) return reduction.completed;
  const { working, elidedChars } = reduction;

  // Commit boundary invariant (#531, representable since #557/#560).
  //
  // Tool-pair splits are unrepresentable at this seam by construction: a
  // tool result is not a standalone message — it lives in `ToolPart.state`
  // on the same assistant `Message.WithParts` that carries the call
  // (protocol `Message.ToolPart` + `Tool.State`), and `Message.Info` has
  // only user/assistant roles. Slicing at WithParts granularity therefore
  // cannot separate a call from its result, so no pair guard exists here.
  // Kept non-terminal (pending/running) tool parts are replay-safe too:
  // `toModelMessages` (packages/llm/src/message/index.ts) expands every
  // ToolPart into an atomic tool-call + tool-result block pair,
  // synthesizing "[Tool execution was interrupted]" for pending/running
  // states — that safety net makes a terminality guard here redundant.
  //
  // The one real hazard is the window START: without a summary user message
  // anchoring the kept window, a window beginning with an assistant message
  // violates provider first-message rules. Snap the cutoff back to the
  // nearest user boundary; refuse loudly when none exists.
  const naturalCutoff = working.length - protectRecent;
  const cutoff =
    options.onSummarize === undefined ? snapToUserBoundary(working, naturalCutoff) : naturalCutoff;
  const unavailable = finishUnavailableCut(cutoff, working, elidedChars, finish);
  if (unavailable !== undefined) return unavailable;

  const toRemove = working.slice(0, cutoff);
  const toKeep = working.slice(cutoff);

  // Anchored cut (compaction-design L2). Three invariants the mechanism
  // owns, whatever the summarizer does:
  //   1. user messages never enter the summarizer — they are preserved
  //      verbatim (newest-first within budget) or dropped from the window,
  //      never paraphrased;
  //   2. a prior anchor render never re-enters the summarizer as content —
  //      its BODY threads through as `previousAnchor`, so summaries merge
  //      instead of recursively re-summarizing (the drift OpenAI measured);
  //   3. an empty merge input costs no model call — the previous anchor
  //      carries forward unchanged.
  const firstRemoved = toRemove[0];
  if (options.onSummarize !== undefined && firstRemoved !== undefined) {
    const preserveBudget = options.preserveUserMessageChars ?? DEFAULT_PRESERVE_USER_CHARS;
    let candidateOutcome: "promoted" | "discarded" | undefined;
    let attempt: AnchoredCutAttempt = {};

    if (candidate !== undefined) {
      if (isWarmCandidateValid(candidate, working)) {
        attempt = await attemptAnchoredCut(
          working.slice(0, candidate.prefixIds.length),
          working.slice(candidate.prefixIds.length),
          candidate.anchorBody,
          working,
          firstRemoved,
          preserveBudget,
          options.contextWindowTokens,
          options.onSummarize,
        );
      }
      candidateOutcome = attempt.cut === undefined ? "discarded" : "promoted";
    }
    if (attempt.cut === undefined) {
      attempt = await attemptAnchoredCut(
        toRemove,
        toKeep,
        undefined,
        working,
        firstRemoved,
        preserveBudget,
        options.contextWindowTokens,
        options.onSummarize,
      );
    }
    if (attempt.summarizerError !== undefined) {
      const fallbackCutoff = snapToUserBoundary(working, naturalCutoff);
      if (fallbackCutoff !== undefined && fallbackCutoff > 0) {
        return finish(
          {
            messages: working.slice(fallbackCutoff),
            compacted: true,
            removedCount: fallbackCutoff,
            summarizerFailed: true,
            ...(candidateOutcome === undefined ? {} : { candidate: candidateOutcome }),
          },
          "cut",
          elidedChars,
          false,
          attempt.summarizerError,
        );
      }
    }
    return finishAnchoredCut(attempt, candidateOutcome, messages, working, elidedChars, finish);
  }

  const compacted = [...toKeep];

  return finish(
    {
      messages: compacted,
      compacted: true,
      removedCount: toRemove.length,
    },
    "cut",
    elidedChars,
    false,
  );
}

function snapToUserBoundary(
  messages: Message.WithParts[],
  naturalCutoff: number,
): number | undefined {
  for (let index = naturalCutoff; index >= 0; index -= 1) {
    if (messages[index]?.info.role === "user") return index;
  }
  return undefined;
}
