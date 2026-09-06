import type { BusEvent } from "@openomni/protocol";
import type { Message } from "@openomni/protocol";
import { RunEvents } from "../core/execution/events";
import { resolveCompactionGeometry, type CompactionYield } from "./geometry";
import { elideToolOutputs, type ToolOutputElision } from "./reduce";
import type { CompactionCandidate } from "./speculate";
import { createCompactionPlan, type CompactionRecord } from "./durable";

interface SummarizationBudget {
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
type ResolvedCompactionOptions = CompactionOptions & { contextWindowTokens: number };

interface CompactionResult {
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

type FinishCompaction = (
  result: CompactionResult,
  outcome: "cut" | "reduced" | "nothing_reclaimed" | "no_user_boundary",
  elidedChars: number,
  anchored?: boolean,
  summarizerError?: Error,
) => CompactionResult;

interface ReducedHistory {
  readonly working: Message.WithParts[];
  readonly elidedChars: number;
  readonly completed?: CompactionResult;
}

interface AnchoredCutAttempt {
  readonly cut?: CompactionResult;
  readonly summarizerError?: Error;
}

// Only decides the cut's eagerness after an elision round — never the trigger.
const ESTIMATED_CHARS_PER_TOKEN = 4;
const BASE64_RUN_RE = /[A-Za-z0-9+/=_-]{512,}/g;
export const DEFAULT_PROTECT_RECENT = 6;
// ~20k tokens of verbatim user text carried through a cut (Codex ships the
// same order of magnitude). Strategy may narrow or widen it.
const DEFAULT_PRESERVE_USER_CHARS = 80_000;
const DEFAULT_SUMMARIZER_DEADLINE_MS = 60_000;
const ANCHOR_HEADER = "[Conversation Summary]\n";

export function withSummarizerDeadline(
  summarize: NonNullable<CompactionOptions["onSummarize"]>,
  deadlineMs = DEFAULT_SUMMARIZER_DEADLINE_MS,
  signal?: AbortSignal,
): NonNullable<CompactionOptions["onSummarize"]> {
  return async (messages, previousAnchor, budget, operationSignal = signal) => {
    const controller = new AbortController();
    const cancellation = Promise.withResolvers<never>();
    const abort = (): void => {
      const error = new Error("compaction summarizer operation aborted");
      error.name = "AbortError";
      controller.abort(error);
      cancellation.reject(error);
    };
    operationSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      const error = new Error(`compaction summarizer exceeded ${deadlineMs}ms deadline`);
      error.name = "SummarizerDeadlineError";
      controller.abort(error);
      cancellation.reject(error);
    }, deadlineMs);
    try {
      if (operationSignal?.aborted === true) abort();
      return await Promise.race([
        summarize(messages, previousAnchor, budget, controller.signal),
        cancellation.promise,
      ]);
    } finally {
      clearTimeout(timer);
      operationSignal?.removeEventListener("abort", abort);
    }
  };
}

/**
 * Time carriage (#737): the one fixed grammar a marker may wear. The whole
 * design leans on this being a closed shape — the L7 byte guard exempts
 * marker parts from the multiset check BECAUSE a 21-char `[recorded date]`
 * line cannot smuggle paraphrased user speech.
 */
const TIME_MARKER_RE = /^\[recorded \d{4}-\d{2}-\d{2}\]$/;

/**
 * Structural marker identity, shared with the L7 byte guard: metadata tags
 * AND the closed grammar. A part wearing the tags around free text is NOT a
 * marker — it stays plain user speech and fails the byte check if new.
 */
function isTimeCarriageMarkerPart(part: Message.Part): boolean {
  return (
    part.type === "text" &&
    part.metadata?.timeCarriage === true &&
    part.metadata?.policyInjected === true &&
    TIME_MARKER_RE.test(part.text)
  );
}

/** UTC calendar date by design: deterministic across hosts and resumes. The
 * anchor render's legend states the convention (review #741 F3) — a
 * host-local render would re-date the same record per machine. */
function renderTimeMarker(createdMs: number): string {
  return `[recorded ${new Date(createdMs).toISOString().slice(0, 10)}]`;
}

/**
 * One-line legend riding the anchor render whenever markers were stamped
 * (review #741 F1): the bench's responder is told what markers mean, so
 * production models must be told too — a measurement the product does not
 * ship is a primed-reader artifact. Render-only: never enters `anchorBody`,
 * so merge threading and the record are untouched. The literal
 * "YYYY-MM-DD" does not match the marker grammar, so the legend can never
 * be mistaken for a marker by the guard or by extraction.
 */
const MARKER_LEGEND =
  "(Messages marked [recorded YYYY-MM-DD] carry the date each message was recorded, in UTC.)";

/** At least one text part that is neither policy-injected nor an anchor
 * render — i.e. the message actually carries user speech worth dating. */
function carriesUserSpeech(message: Message.WithParts): boolean {
  return message.parts.some(
    (part) =>
      part.type === "text" &&
      part.metadata?.policyInjected !== true &&
      part.metadata?.compactionAnchor !== true,
  );
}

/**
 * Temporal grounding for the preserved-verbatim lane (#737): the bench
 * showed temporal QA collapsing to 4.8% of the full-history ceiling because
 * preserved user text says "yesterday" and nothing in the window says when
 * that was. The marker is REGENERATED from `info.time.created` at every cut
 * (any stale marker part is replaced, never accumulated — the #722 stacking
 * class), rides beside the user text as a policy-injected part, and never
 * enters the record: the replacement record carries the structured `time`
 * instead, so resume re-derives markers rather than replaying them.
 */
function stampTimeMarker(message: Message.WithParts): Message.WithParts {
  const marker: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID: message.info.sessionID,
    messageID: message.info.id,
    type: "text",
    text: renderTimeMarker(message.info.time.created),
    metadata: { policyInjected: true, timeCarriage: true },
  };
  return {
    info: message.info,
    parts: [marker, ...message.parts.filter((part) => !isTimeCarriageMarkerPart(part))],
  };
}

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

function replacementRecord(
  stampedUsers: readonly Message.WithParts[],
  keepSpan: readonly Message.WithParts[],
): Array<{
  role: "user" | "assistant";
  text: string;
  time: number;
  policyInjected?: true;
}> {
  return [...stampedUsers, ...keepSpan].flatMap((message) =>
    message.parts
      .filter(
        (part): part is Message.TextPart => part.type === "text" && !isTimeCarriageMarkerPart(part),
      )
      .map((part) => ({
        role: message.info.role,
        text: part.text,
        time: message.info.time.created,
        ...(part.metadata?.policyInjected === true ? { policyInjected: true as const } : {}),
      })),
  );
}

async function attemptAnchoredCut(
  cutSpan: Message.WithParts[],
  keepSpan: Message.WithParts[],
  precomputed: string | undefined,
  working: Message.WithParts[],
  firstRemoved: Message.WithParts,
  preserveBudget: number,
  contextWindowTokens: number,
  onSummarize: NonNullable<CompactionOptions["onSummarize"]>,
): Promise<AnchoredCutAttempt> {
  const previousAnchor = latestAnchorBody(cutSpan);
  const summarizerInput = cutSpan.filter(
    (message) => message.info.role !== "user" && !isAnchorMessage(message),
  );
  const { messages: boundedInput, budget } = prepareSummarizerInput(
    summarizerInput,
    contextWindowTokens,
    previousAnchor,
  );
  let anchorText = precomputed ?? previousAnchor;
  let summarizerError: Error | undefined;
  if (precomputed === undefined && boundedInput.length > 0) {
    try {
      const merged = await onSummarize(boundedInput, previousAnchor, budget);
      anchorText = merged.trim().length > 0 ? merged : previousAnchor;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (normalized.name === "AbortError") throw normalized;
      summarizerError = normalized;
      anchorText = previousAnchor;
    }
  }

  const preservedUsers = selectPreservedUsers(cutSpan, preserveBudget);
  if (anchorText === undefined && preservedUsers.length === 0) return { summarizerError };
  const stampedUsers = preservedUsers.map((message) =>
    carriesUserSpeech(message) ? stampTimeMarker(message) : message,
  );
  const keptWindow = replacementRecord(stampedUsers, keepSpan);
  const stampedAny = stampedUsers.some((message) => message.parts.some(isTimeCarriageMarkerPart));
  const anchorMessages =
    anchorText === undefined
      ? []
      : [
          buildAnchorMessage(
            anchorText,
            firstRemoved.info.sessionID,
            firstRemoved.info.agent,
            keptWindow,
            stampedAny,
          ),
        ];
  const compacted = [...anchorMessages, ...stampedUsers, ...keepSpan];
  if (estimateContentChars(compacted) >= estimateContentChars(working)) {
    return { summarizerError };
  }
  return {
    cut: {
      messages: compacted,
      compacted: true,
      removedCount: cutSpan.length - preservedUsers.length,
    },
    summarizerError,
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

export namespace Compaction {
  export function shouldCompact(
    totalTokens: number,
    options: ResolvedCompactionOptions,
    previousYield?: CompactionYield,
  ): boolean {
    return totalTokens >= resolveThresholdTokens(options, previousYield);
  }

  /**
   * @param identity The run whose history is being rewritten. A separate
   * required parameter rather than a field on `options`: identity is a
   * per-call fact, not configuration, and an optional field validated by a
   * runtime throw gives the compiler nothing — which is how the caller that
   * supplied none reached production.
   * @param events Where the record of the rewrite goes. Beside the identity,
   * not inside it: a destination is not something the trace says.
   * @param dispatch What fired the seam and what was measured — per-dispatch
   * facts the bracket records.
   *
   * The lock bracket: exactly one `agent.compaction.started` before any work
   * and exactly one `agent.compaction.completed` as the last record on every
   * exit path, a summarizer throw included. A started without a completed
   * diagnoses a run that died inside compaction.
   */
  export async function compact(
    messages: Message.WithParts[],
    options: ResolvedCompactionOptions,
    identity: {
      readonly traceId: string;
      readonly sessionId: string;
      readonly runId?: string;
      readonly actorId?: string;
    },
    events: BusEvent.Sink,
    dispatch: {
      readonly trigger: "threshold" | "yield";
      readonly signal?: AbortSignal;
      readonly measuredTokens?: number;
      /** A speculative candidate (L4): promoted with zero model calls when
       * its canonical prefix is unchanged; otherwise the synchronous merge
       * runs and the result reports the discard. */
      readonly candidate?: CompactionCandidate;
    },
  ): Promise<CompactionResult> {
    const messagesBefore = messages.length;
    events.publish(RunEvents.CompactionStarted, {
      ...identity,
      time: Date.now(),
      messagesBefore,
      ...(dispatch.measuredTokens === undefined ? {} : { contextTokens: dispatch.measuredTokens }),
      trigger: dispatch.trigger,
      summarizer: options.onSummarize !== undefined,
    });

    const finish = (
      result: CompactionResult,
      outcome: "cut" | "reduced" | "nothing_reclaimed" | "no_user_boundary",
      elidedChars: number,
      anchored?: boolean,
      summarizerError?: Error,
    ): CompactionResult => {
      const estimatedTokensBefore = estimateMessagesTokens(messages);
      const tokensBefore = dispatch.measuredTokens ?? estimatedTokensBefore;
      const savedTokens = Math.max(
        0,
        estimatedTokensBefore - estimateMessagesTokens(result.messages),
      );
      const ineffective = result.compacted && isIneffectiveCompaction(savedTokens, tokensBefore);
      const completed = result.compacted
        ? {
            ...result,
            record: createCompactionPlan(messages, result.messages, tokensBefore).record,
            yield: { savedTokens, tokensBefore },
            ineffective,
          }
        : result;
      events.publish(RunEvents.CompactionCompleted, {
        ...identity,
        time: Date.now(),
        outcome,
        messagesBefore,
        messagesAfter: result.messages.length,
        removedCount: result.removedCount,
        elidedChars,
        ...(result.compacted ? { savedTokens, tokensBefore, ineffective } : {}),
        ...(anchored === undefined ? {} : { anchored }),
        ...(summarizerError === undefined ? {} : { error: summarizerError.message }),
      });
      return completed;
    };

    try {
      const boundedOptions =
        options.onSummarize === undefined
          ? options
          : {
              ...options,
              onSummarize: withSummarizerDeadline(
                options.onSummarize,
                options.summarizerDeadlineMs,
                dispatch.signal,
              ),
            };
      return await compactUnbracketed(
        messages,
        boundedOptions,
        dispatch.measuredTokens,
        dispatch.candidate,
        finish,
      );
    } catch (error) {
      // The one exit finish() cannot serve: the summarizer threw. The
      // bracket still closes — `failed` is this operation's terminal — and
      // the throw propagates unchanged into the seam's fail-closed contract.
      events.publish(RunEvents.CompactionCompleted, {
        ...identity,
        time: Date.now(),
        outcome: "failed",
        messagesBefore,
        messagesAfter: messagesBefore,
        removedCount: 0,
        elidedChars: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async function compactUnbracketed(
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
      options.onSummarize === undefined
        ? snapToUserBoundary(working, naturalCutoff)
        : naturalCutoff;
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
}

function resolveThresholdTokens(
  options: ResolvedCompactionOptions,
  previousYield?: CompactionYield,
): number {
  return resolveCompactionGeometry({
    contextWindowTokens: options.contextWindowTokens,
    ...(options.reserveTokens === undefined ? {} : { reserveTokens: options.reserveTokens }),
    ...(previousYield === undefined ? {} : { previousYield }),
  }).thresholdTokens;
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

/**
 * The anchored-cut plan, shared by the seam and the speculator (L4): which
 * span a cut would summarize right now, by id, with the exclusions the L2
 * contract owns (user messages and prior anchor renders never reach the
 * summarizer). Pure — no elision, no events, no rebuild.
 */
export function planAnchoredCut(
  messages: readonly Message.WithParts[],
  protectRecentMessages: number,
):
  | {
      readonly prefixIds: readonly string[];
      readonly prefixFingerprint: string;
      readonly previousAnchor: string | undefined;
      readonly summarizerInput: Message.WithParts[];
    }
  | undefined {
  if (messages.length <= protectRecentMessages) return undefined;
  const cutoff = messages.length - protectRecentMessages;
  if (cutoff <= 0) return undefined;
  const toRemove = messages.slice(0, cutoff);
  return {
    prefixIds: toRemove.map((message) => message.info.id),
    prefixFingerprint: canonicalPrefixFingerprint(toRemove),
    previousAnchor: latestAnchorBody(toRemove),
    summarizerInput: toRemove.filter(
      (message) => message.info.role !== "user" && !isAnchorMessage(message),
    ),
  };
}

/**
 * Anchor identity is structural — the metadata flag, never string-matching
 * on the render — so later render decoration (L6: artifact table, goal
 * recitation) cannot break extraction. `anchorBody` in metadata is the raw
 * merge state the next cut threads back into the summarizer; the part text
 * is its model-facing render.
 */
function isAnchorMessage(message: Message.WithParts): boolean {
  return (
    message.info.role === "user" &&
    message.parts.some((part) => part.type === "text" && part.metadata?.compactionAnchor === true)
  );
}

export function latestCompactionAnchorId(
  span: readonly Message.WithParts[],
): string | undefined {
  for (let index = span.length - 1; index >= 0; index -= 1) {
    const message = span[index];
    if (message !== undefined && isAnchorMessage(message)) return message.info.id;
  }
  return undefined;
}

export function isWarmCandidateValid(
  candidate: CompactionCandidate,
  messages: readonly Message.WithParts[],
): boolean {
  const cut = messages.findIndex((message) => message.info.id === candidate.firstKeptId);
  if (cut !== candidate.prefixIds.length) return false;
  if (latestCompactionAnchorId(messages) !== candidate.compactionAnchorId) return false;
  if (!candidate.prefixIds.every((id, index) => messages[index]?.info.id === id)) return false;
  return (
    canonicalPrefixFingerprint(messages.slice(0, candidate.prefixIds.length)) ===
    candidate.prefixFingerprint
  );
}

function canonicalPartContent(part: Message.Part): unknown {
  if (part.type === "text") return { type: part.type, text: part.text, metadata: part.metadata };
  if (part.type === "reasoning") {
    return { type: part.type, text: part.text, signature: part.signature, metadata: part.metadata };
  }
  if (part.type === "step-start") return { type: part.type };
  if (part.type === "step-finish") {
    return { type: part.type, reason: part.reason, cost: part.cost, tokens: part.tokens };
  }
  const state =
    part.state.status === "completed" ? { ...part.state, output: "[tool output]" } : part.state;
  return { type: part.type, callID: part.callID, tool: part.tool, state };
}

function canonicalPrefixFingerprint(messages: readonly Message.WithParts[]): string {
  const canonical = JSON.stringify(
    messages.map((message) => ({
      role: message.info.role,
      parts: message.parts.map(canonicalPartContent),
    })),
  );
  let hash = 2_166_136_261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function latestAnchorBody(span: readonly Message.WithParts[]): string | undefined {
  for (let index = span.length - 1; index >= 0; index -= 1) {
    // The parameter is a dense Message.WithParts[] assembled by slice/spread;
    // an in-bounds element is therefore present.
    const message = span[index] as Message.WithParts;
    // One identity, one definition (review #721 M3): only what
    // isAnchorMessage accepts may thread its body — an assistant-role part
    // wearing the metadata is content, never state.
    if (!isAnchorMessage(message)) continue;
    // isAnchorMessage just proved this element exists; repeat the predicate
    // only to retrieve it, not as a second impossible fallback branch.
    const part = message.parts.find(
      (candidate): candidate is Message.TextPart =>
        candidate.type === "text" && candidate.metadata?.compactionAnchor === true,
    ) as Message.TextPart;
    const body = part.metadata?.anchorBody;
    // A marked part without a string body is a foreign or corrupt render:
    // fall back to the visible text rather than dropping the anchor.
    return typeof body === "string" ? body : part.text;
  }
  return undefined;
}

function userTextChars(message: Message.WithParts): number {
  // All content weighs against the budget (review #721 M4): a user-role
  // message bulked by a tool output must not ride through a 10-char budget
  // as if free.
  let chars = 0;
  for (const part of message.parts) {
    if (part.type === "text") chars += part.text.length;
    else if (part.type === "tool" && part.state.status === "completed") {
      chars += part.state.output.length;
    }
  }
  return chars;
}

/**
 * Window-size proxy for the progress guard: the same content classes the
 * model projection actually resends (text and completed tool outputs).
 */
function estimateContentChars(span: readonly Message.WithParts[]): number {
  let chars = 0;
  for (const message of span) {
    chars += userTextChars(message);
  }
  return chars;
}

function weightedTextChars(text: string): number {
  let weighted = text.length;
  for (const match of text.matchAll(BASE64_RUN_RE)) weighted += match[0].length * 3;
  return weighted;
}

export function estimateMessagesTokens(messages: readonly Message.WithParts[]): number {
  let weightedChars = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text") weightedChars += weightedTextChars(part.text);
      else if (part.type === "tool" && part.state.status === "completed") {
        weightedChars += weightedTextChars(part.state.output);
      }
    }
  }
  return Math.ceil(weightedChars / ESTIMATED_CHARS_PER_TOKEN);
}

export function isIneffectiveCompaction(savedTokens: number, tokensBefore: number): boolean {
  return savedTokens < 1024 || savedTokens / Math.max(1, tokensBefore) < 0.1;
}

export function prepareSummarizerInput(
  messages: readonly Message.WithParts[],
  contextWindowTokens: number,
  previousAnchor?: string,
): { readonly messages: Message.WithParts[]; readonly budget: SummarizationBudget } {
  const halfWindow = Math.max(0, Math.floor(contextWindowTokens * 0.5));
  const messageBudget = Math.max(
    0,
    halfWindow - Math.ceil(weightedTextChars(previousAnchor ?? "") / ESTIMATED_CHARS_PER_TOKEN),
  );
  const budget = {
    maxInputTokens: halfWindow,
    maxOutputTokens: Math.min(32_768, halfWindow),
    contextWindowTokens,
  };
  const elided = messages.map((message) => {
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return part;
      const marker = `[tool output elided for summarization: ${part.state.output.length} chars]`;
      if (marker.length >= part.state.output.length) return part;
      changed = true;
      return { ...part, state: { ...part.state, output: marker } };
    });
    return changed ? { ...message, parts } : message;
  });
  let first = 0;
  while (first < elided.length && estimateMessagesTokens(elided.slice(first)) > messageBudget) {
    first += 1;
  }
  return { messages: elided.slice(first), budget };
}

/**
 * Newest-first selection under the budget, returned in original order. The
 * newest user message is taken unconditionally: a budget that silently
 * dropped ALL user text would violate the invariant the budget exists to
 * serve.
 */
function selectPreservedUsers(
  span: readonly Message.WithParts[],
  budgetChars: number,
): Message.WithParts[] {
  const users = span.filter((message) => message.info.role === "user" && !isAnchorMessage(message));
  const kept: Message.WithParts[] = [];
  let total = 0;
  for (let index = users.length - 1; index >= 0; index -= 1) {
    const candidate = users[index];
    if (candidate === undefined) continue;
    const size = userTextChars(candidate);
    if (kept.length > 0 && total + size > budgetChars) break;
    kept.unshift(candidate);
    total += size;
  }
  return kept;
}

function buildAnchorMessage(
  anchorBody: string,
  sessionID: string,
  agent: string,
  keptWindow: ReadonlyArray<{ role: "user" | "assistant"; text: string; time: number }>,
  withMarkerLegend: boolean,
): Message.WithParts {
  const id = crypto.randomUUID();
  const now = Date.now();
  const render = `${ANCHOR_HEADER}${anchorBody}${withMarkerLegend ? `\n\n${MARKER_LEGEND}` : ""}`;
  const info: Message.UserMessage = {
    id,
    sessionID,
    role: "user",
    time: { created: now },
    agent,
    model: { providerID: "", modelID: "" },
    system: render,
  };
  const textPart: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "text",
    text: render,
    metadata: {
      compactionAnchor: true,
      anchorBody,
      // Ordered window selection after this anchor — the durable
      // replacement record (#702). Content-borne: hydration flattens to
      // role/content and re-mints ids, so an id record would resolve to
      // nothing (#722 review). Size expectation: one copy of the preserve
      // budget (default 80k chars) plus the protected tail per cut, in an
      // append-only store — linear per record, and the newest-user
      // unconditional rule means one oversized user message can ride into
      // every subsequent record by design (user tokens are irreplaceable).
      keptWindow,
    },
  };
  return { info, parts: [textPart] };
}
