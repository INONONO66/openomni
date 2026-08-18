import type { BusEvent } from "@openomni/protocol";
import { AgentExecution, type Message } from "@openomni/protocol";
import { elideToolOutputs, type ToolOutputElision } from "./reduce";
import type { CompactionCandidate } from "./speculate";

export interface CompactionOptions {
  /**
   * Optional narrowing of the model's window. The loop records the resolved
   * model's real limit and the policy reads it from the dispatch context, so
   * strategy config only sets this to compact as if the window were smaller.
   */
  contextWindowTokens?: number;
  thresholdRatio?: number;
  reserveTokens?: number;
  reserveRatio?: number;
  protectRecentMessages?: number;
  /**
   * Anchored iterative summarization (compaction-design L2). The summarizer
   * receives the newly cut span WITH user messages and prior anchor renders
   * already excluded, plus the previous anchor body when one exists — it
   * merges, it never regenerates. The mechanism owns the exclusions and the
   * threading; what the summarizer does with them is strategy.
   */
  onSummarize?: (messages: Message.WithParts[], previousAnchor?: string) => Promise<string>;
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
  speculate?: false | { prepareRatio?: number };
}

/** Options with the window already resolved — the mechanism never guesses it. */
type ResolvedCompactionOptions = CompactionOptions & { contextWindowTokens: number };

interface CompactionResult {
  messages: Message.WithParts[];
  compacted: boolean;
  removedCount: number;
  /** L4: what happened to the speculative candidate, when one was offered. */
  candidate?: "promoted" | "discarded";
  /** Set when the trigger fired but no provider-valid cut exists: no summary
   * anchor and no user boundary at or before the cutoff. The caller records
   * it; killing the run over housekeeping would be worse than a full window. */
  blocked?: "no_user_boundary";
}

/**
 * One ratio, two readers: the compaction trigger's default threshold, and the
 * loop's step-boundary yield — they must agree, or the loop yields at a level
 * the trigger refuses to act on (or never yields where the trigger would).
 */
export const DEFAULT_THRESHOLD_RATIO = 0.8;
// Only decides the cut's eagerness after an elision round — never the trigger.
const ESTIMATED_CHARS_PER_TOKEN = 4;
export const DEFAULT_PROTECT_RECENT = 6;
// ~20k tokens of verbatim user text carried through a cut (Codex ships the
// same order of magnitude). Strategy may narrow or widen it.
const DEFAULT_PRESERVE_USER_CHARS = 80_000;
const ANCHOR_HEADER = "[Conversation Summary]\n";

export namespace Compaction {
  export function shouldCompact(totalTokens: number, options: ResolvedCompactionOptions): boolean {
    const threshold = resolveThresholdTokens(options);
    return totalTokens >= threshold;
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
    identity: { readonly traceId: string; readonly sessionId: string; readonly runId?: string },
    events: BusEvent.Sink,
    dispatch: {
      readonly trigger: "threshold" | "yield";
      readonly measuredTokens?: number;
      /** A speculative candidate (L4): promoted with zero model calls when
       * its span is still a live id-prefix of the history; otherwise the
       * synchronous merge runs and the result reports the discard. */
      readonly candidate?: CompactionCandidate;
    },
  ): Promise<CompactionResult> {
    const messagesBefore = messages.length;
    events.publish(AgentExecution.CompactionStarted, {
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
    ): CompactionResult => {
      events.publish(AgentExecution.CompactionCompleted, {
        ...identity,
        time: Date.now(),
        outcome,
        messagesBefore,
        messagesAfter: result.messages.length,
        removedCount: result.removedCount,
        elidedChars,
        ...(anchored === undefined ? {} : { anchored }),
      });
      return result;
    };

    try {
      return await compactUnbracketed(
        messages,
        options,
        dispatch.measuredTokens,
        dispatch.candidate,
        finish,
      );
    } catch (error) {
      // The one exit finish() cannot serve: the summarizer threw. The
      // bracket still closes — `failed` is this operation's terminal — and
      // the throw propagates unchanged into the seam's fail-closed contract.
      events.publish(AgentExecution.CompactionCompleted, {
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
    ) => CompactionResult,
  ): Promise<CompactionResult> {
    const protectRecent = options.protectRecentMessages ?? DEFAULT_PROTECT_RECENT;

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
    let working = messages;
    let elidedChars = 0;
    if (options.elideToolOutputs !== undefined) {
      const reduction = elideToolOutputs(messages, protectRecent, options.elideToolOutputs);
      if (reduction.elidedChars > 0) {
        working = reduction.messages;
        elidedChars = reduction.elidedChars;
        const overageTokens =
          measuredContextTokens === undefined
            ? undefined
            : measuredContextTokens - resolveThresholdTokens(options);
        const estimatedReclaimTokens = elidedChars / ESTIMATED_CHARS_PER_TOKEN;
        if (overageTokens === undefined || estimatedReclaimTokens >= overageTokens) {
          return finish(
            { messages: working, compacted: true, removedCount: 0 },
            "reduced",
            elidedChars,
          );
        }
      }
    }

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
    if (cutoff === undefined) {
      // No provider-valid kept window exists (assistant-first history, no
      // summary anchor). Adversarial review of the live wiring showed this
      // reachable from resumed worker hydration — a throw here would turn a
      // fail-closed run.completion.pre into a mid-conversation kill.
      return elidedChars > 0
        ? finish({ messages: working, compacted: true, removedCount: 0 }, "reduced", elidedChars)
        : finish(
            { messages: working, compacted: false, removedCount: 0, blocked: "no_user_boundary" },
            "no_user_boundary",
            0,
          );
    }
    if (cutoff === 0) {
      return elidedChars > 0
        ? finish({ messages: working, compacted: true, removedCount: 0 }, "reduced", elidedChars)
        : finish({ messages: working, compacted: false, removedCount: 0 }, "nothing_reclaimed", 0);
    }

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
    if (options.onSummarize && firstRemoved !== undefined) {
      const onSummarize = options.onSummarize;
      const preserveBudget = options.preserveUserMessageChars ?? DEFAULT_PRESERVE_USER_CHARS;

      // One cut attempt over a chosen span. `precomputed` set = promote path
      // (zero model calls); unset = synchronous merge. Returns undefined when
      // the attempt cannot commit (no user-roled window head, or the rebuild
      // is not strictly smaller — the #721 M1 progress guard).
      const attemptCut = async (
        cutSpan: Message.WithParts[],
        keepSpan: Message.WithParts[],
        precomputed: string | undefined,
      ): Promise<CompactionResult | undefined> => {
        const previousAnchor = latestAnchorBody(cutSpan);
        const summarizerInput = cutSpan.filter(
          (message) => message.info.role !== "user" && !isAnchorMessage(message),
        );
        let anchorText = precomputed ?? previousAnchor;
        if (precomputed === undefined && summarizerInput.length > 0) {
          const merged = await onSummarize(summarizerInput, previousAnchor);
          anchorText = merged.trim().length > 0 ? merged : previousAnchor;
        }
        const preservedUsers = selectPreservedUsers(cutSpan, preserveBudget);
        if (anchorText === undefined && preservedUsers.length === 0) return undefined;
        // The replacement record rides ON the anchor (compaction-design L3,
        // #702): the ordered CONTENT kept after the anchor, not ids — message
        // ids do not survive the hydration seam (resume flattens to
        // role/content strings and the run re-mints ids; #722 review finding
        // 1 proved an id record resolves to nothing on every production
        // path). Size expectation: one copy of the preserve budget (default
        // 80k chars) plus the protected tail per cut, in an append-only store
        // — linear per record, and the newest-user unconditional rule means
        // one oversized user message can ride into every subsequent record by
        // design (user tokens are irreplaceable).
        const keptWindow = [...preservedUsers, ...keepSpan].flatMap((message) =>
          message.parts
            .filter((part): part is Message.TextPart => part.type === "text")
            .map((part) => ({
              role: message.info.role,
              text: part.text,
              // Provenance survives resume (#727 review): a policy-injected
              // nudge replayed from the record must not become "the user's
              // goal" in a later epoch's decoration.
              ...(part.metadata?.policyInjected === true ? { policyInjected: true } : {}),
            })),
        );
        const anchorMessages =
          anchorText === undefined
            ? []
            : [
                buildAnchorMessage(
                  anchorText,
                  firstRemoved.info.sessionID,
                  firstRemoved.info.agent,
                  keptWindow,
                ),
              ];
        const compacted = [...anchorMessages, ...preservedUsers, ...keepSpan];
        // Progress guard (review #721 M1): the rebuilt window must be strictly
        // smaller than what the seam received, or committing it would count as
        // progress toward the #651 disarm while reclaiming nothing.
        if (estimateContentChars(compacted) >= estimateContentChars(working)) return undefined;
        return {
          messages: compacted,
          compacted: true,
          removedCount: cutSpan.length - preservedUsers.length,
        };
      };

      // Promote-or-merge (L4, #724 review M1): a fresh candidate's span is a
      // live id-prefix — cut exactly that span with the precomputed anchor,
      // zero model calls. But a promote that cannot commit (progress guard,
      // window-head refusal) is a DISCARD, not a promotion: the seam falls
      // back to the synchronous merge over the natural span, exactly what a
      // speculation-free seam would have done. Speculation may only ever add
      // a fast path, never take a cut away.
      let candidateOutcome: "promoted" | "discarded" | undefined;
      let cut: CompactionResult | undefined;
      if (candidate !== undefined) {
        const live =
          candidate.spanIds.length > 0 &&
          candidate.spanIds.length <= working.length &&
          candidate.spanIds.every((id, index) => working[index]?.info.id === id);
        if (live) {
          cut = await attemptCut(
            working.slice(0, candidate.spanIds.length),
            working.slice(candidate.spanIds.length),
            candidate.anchorBody,
          );
        }
        candidateOutcome = cut === undefined ? "discarded" : "promoted";
      }
      if (cut === undefined) {
        cut = await attemptCut(toRemove, toKeep, undefined);
      }
      const withOutcome = (result: CompactionResult): CompactionResult =>
        candidateOutcome === undefined ? result : { ...result, candidate: candidateOutcome };
      if (cut === undefined) {
        // Neither span can commit: nothing user-roled can head the kept
        // window, or no rebuild is strictly smaller. Same refusal values as
        // the no-summarizer path; the elision result (if any) is kept.
        return elidedChars > 0
          ? finish(
              withOutcome({ messages: working, compacted: true, removedCount: 0 }),
              "reduced",
              elidedChars,
            )
          : finish(
              withOutcome({ messages, compacted: false, removedCount: 0 }),
              "nothing_reclaimed",
              0,
            );
      }
      return finish(
        withOutcome(cut),
        "cut",
        elidedChars,
        cut.messages[0] !== undefined && isAnchorMessage(cut.messages[0]),
      );
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

function resolveThresholdTokens(options: ResolvedCompactionOptions): number {
  const ratioThreshold =
    options.contextWindowTokens * (options.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO);
  const reserveTokens = resolveReserveTokens(options);
  if (reserveTokens === undefined) return ratioThreshold;
  return Math.min(ratioThreshold, options.contextWindowTokens - reserveTokens);
}

function resolveReserveTokens(options: ResolvedCompactionOptions): number | undefined {
  const reserveTokens =
    options.reserveTokens ??
    (options.reserveRatio === undefined
      ? undefined
      : options.contextWindowTokens * options.reserveRatio);
  if (reserveTokens === undefined || !Number.isFinite(reserveTokens)) return undefined;
  return Math.min(options.contextWindowTokens, Math.max(0, reserveTokens));
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
      readonly spanIds: readonly string[];
      readonly previousAnchor: string | undefined;
      readonly summarizerInput: Message.WithParts[];
    }
  | undefined {
  if (messages.length <= protectRecentMessages) return undefined;
  const cutoff = messages.length - protectRecentMessages;
  if (cutoff <= 0) return undefined;
  const toRemove = messages.slice(0, cutoff);
  return {
    spanIds: toRemove.map((message) => message.info.id),
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

function latestAnchorBody(span: readonly Message.WithParts[]): string | undefined {
  for (let index = span.length - 1; index >= 0; index -= 1) {
    const message = span[index];
    if (message === undefined) continue;
    // One identity, one definition (review #721 M3): only what
    // isAnchorMessage accepts may thread its body — an assistant-role part
    // wearing the metadata is content, never state.
    if (!isAnchorMessage(message)) continue;
    for (const part of message.parts) {
      if (part.type !== "text" || part.metadata?.compactionAnchor !== true) continue;
      const body = part.metadata?.anchorBody;
      // A marked part without a string body is a foreign or corrupt render:
      // fall back to the visible text rather than dropping the anchor.
      return typeof body === "string" ? body : part.text;
    }
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
  keptWindow: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
): Message.WithParts {
  const id = crypto.randomUUID();
  const now = Date.now();
  const render = `${ANCHOR_HEADER}${anchorBody}`;
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
      keptWindow: keptWindow.map((entry) => ({ ...entry })),
    },
  };
  return { info, parts: [textPart] };
}
