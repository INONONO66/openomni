import type { BusEvent } from "@openomni/protocol";
import { Operational, type Message } from "@openomni/protocol";
import { elideToolOutputs, type ToolOutputElision } from "./reduce";

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
  onSummarize?: (messages: Message.WithParts[]) => Promise<string>;
  /**
   * Opt-in deterministic reduction: when the trigger fires, old completed
   * tool outputs are elided first; the lossy cut joins the same round
   * whenever the estimated net reclaim cannot cover the measured overage.
   * The knobs are strategy, so they arrive as config.
   */
  elideToolOutputs?: ToolOutputElision;
}

/** Options with the window already resolved — the mechanism never guesses it. */
type ResolvedCompactionOptions = CompactionOptions & { contextWindowTokens: number };

interface CompactionResult {
  messages: Message.WithParts[];
  compacted: boolean;
  removedCount: number;
  /** Set when the trigger fired but no provider-valid cut exists: no summary
   * anchor and no user boundary at or before the cutoff. The caller records
   * it; killing the run over housekeeping would be worse than a full window. */
  blocked?: "no_user_boundary";
}

const DEFAULT_THRESHOLD_RATIO = 0.8;
// Only decides the cut's eagerness after an elision round — never the trigger.
const ESTIMATED_CHARS_PER_TOKEN = 4;
const DEFAULT_PROTECT_RECENT = 6;

export namespace Compaction {
  export function shouldCompact(totalTokens: number, options: ResolvedCompactionOptions): boolean {
    const threshold = resolveThresholdTokens(options);
    return totalTokens >= threshold;
  }

  /**
   * @param trace The run whose history is being rewritten. A separate required
   * parameter rather than a field on `options`: the trace is a per-call fact,
   * not configuration, and an optional field validated by a runtime throw
   * gives the compiler nothing — which is how the caller that supplied none
   * reached production.
   * @param events Where the record of the rewrite goes. Beside the identity,
   * not inside it: a destination is not something the trace says.
   */
  export async function compact(
    messages: Message.WithParts[],
    options: ResolvedCompactionOptions,
    trace: { readonly traceId: string },
    events: BusEvent.Sink,
    measuredContextTokens?: number,
  ): Promise<CompactionResult> {
    const protectRecent = options.protectRecentMessages ?? DEFAULT_PROTECT_RECENT;

    if (messages.length <= protectRecent) {
      return { messages, compacted: false, removedCount: 0 };
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
        events.publish(Operational.Info, {
          traceId: trace.traceId,
          time: Date.now(),
          component: "agent.compaction",
          msg: "compaction reduced tool outputs",
          context: {
            elidedChars: reduction.elidedChars,
            messageCount: messages.length,
            reason: "context window threshold exceeded",
          },
        });
        const overageTokens =
          measuredContextTokens === undefined
            ? undefined
            : measuredContextTokens - resolveThresholdTokens(options);
        const estimatedReclaimTokens = elidedChars / ESTIMATED_CHARS_PER_TOKEN;
        if (overageTokens === undefined || estimatedReclaimTokens >= overageTokens) {
          return { messages: working, compacted: true, removedCount: 0 };
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
        ? { messages: working, compacted: true, removedCount: 0 }
        : { messages: working, compacted: false, removedCount: 0, blocked: "no_user_boundary" };
    }
    if (cutoff === 0) {
      return elidedChars > 0
        ? { messages: working, compacted: true, removedCount: 0 }
        : { messages: working, compacted: false, removedCount: 0 };
    }

    const toRemove = working.slice(0, cutoff);
    const toKeep = working.slice(cutoff);

    let summaryMessages: Message.WithParts[] = [];
    const firstRemoved = toRemove[0];
    if (options.onSummarize && firstRemoved !== undefined) {
      const summaryText = await options.onSummarize(toRemove);
      summaryMessages = [
        buildSummaryMessage(summaryText, firstRemoved.info.sessionID, firstRemoved.info.agent),
      ];
    }

    const compacted = [...summaryMessages, ...toKeep];

    events.publish(Operational.Info, {
      traceId: trace.traceId,
      time: Date.now(),
      component: "agent.compaction",
      msg: "compaction triggered",
      context: {
        messagesBefore: working.length,
        messagesAfter: compacted.length,
        removedCount: toRemove.length,
        reason: "context window threshold exceeded",
      },
    });

    return {
      messages: compacted,
      compacted: true,
      removedCount: toRemove.length,
    };
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

function buildSummaryMessage(
  summaryText: string,
  sessionID: string,
  agent: string,
): Message.WithParts {
  const id = crypto.randomUUID();
  const now = Date.now();
  const info: Message.UserMessage = {
    id,
    sessionID,
    role: "user",
    time: { created: now },
    agent,
    model: { providerID: "", modelID: "" },
    system: `[Conversation Summary]\n${summaryText}`,
  };
  const textPart: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "text",
    text: `[Conversation Summary]\n${summaryText}`,
  };
  return { info, parts: [textPart] };
}
