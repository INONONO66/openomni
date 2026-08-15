import type { BusEvent } from "@openomni/protocol";
import { Operational, type Message } from "@openomni/protocol";
import { elideToolOutputs, type ToolOutputElision } from "./reduce";

export interface CompactionOptions {
  contextWindowTokens: number;
  thresholdRatio?: number;
  reserveTokens?: number;
  reserveRatio?: number;
  protectRecentMessages?: number;
  onSummarize?: (messages: Message.WithParts[]) => Promise<string>;
  /**
   * Opt-in deterministic reduction: when the trigger fires, old completed
   * tool outputs are elided first, and the lossy cut runs only when elision
   * reclaimed nothing. The knobs are strategy, so they arrive as config.
   */
  elideToolOutputs?: ToolOutputElision;
}

interface CompactionResult {
  messages: Message.WithParts[];
  compacted: boolean;
  removedCount: number;
}

/**
 * Raised when compaction cannot commit a provider-valid kept window: no
 * summary user message will anchor the window (onSummarize unset) and no user
 * boundary exists at or before the cutoff. Thrown BEFORE anything is
 * committed — the fail-closed `run.completion.pre` contract turns it into a
 * deny plus a published middleware error, never commit-then-400.
 */
export class CompactionBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionBoundaryError";
  }
}

const DEFAULT_THRESHOLD_RATIO = 0.8;
const DEFAULT_PROTECT_RECENT = 6;

export namespace Compaction {
  export function shouldCompact(totalTokens: number, options: CompactionOptions): boolean {
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
    options: CompactionOptions,
    trace: { readonly traceId: string },
    events: BusEvent.Sink,
  ): Promise<CompactionResult> {
    const protectRecent = options.protectRecentMessages ?? DEFAULT_PROTECT_RECENT;

    if (messages.length <= protectRecent) {
      return { messages, compacted: false, removedCount: 0 };
    }

    // Reduction before the cut: eliding old tool outputs reclaims window
    // without dropping a message, so the cut below is the fallback for a
    // history with nothing left to elide. The next measured call reports the
    // yield — one reduction per trigger, no same-pass re-measure guessing.
    if (options.elideToolOutputs !== undefined) {
      const reduction = elideToolOutputs(messages, protectRecent, options.elideToolOutputs);
      if (reduction.elidedChars > 0) {
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
        return { messages: reduction.messages, compacted: true, removedCount: 0 };
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
    const naturalCutoff = messages.length - protectRecent;
    const cutoff =
      options.onSummarize === undefined
        ? snapToUserBoundary(messages, naturalCutoff)
        : naturalCutoff;
    if (cutoff === 0) {
      return { messages, compacted: false, removedCount: 0 };
    }

    const toRemove = messages.slice(0, cutoff);
    const toKeep = messages.slice(cutoff);

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
        messagesBefore: messages.length,
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

function resolveThresholdTokens(options: CompactionOptions): number {
  const ratioThreshold =
    options.contextWindowTokens * (options.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO);
  const reserveTokens = resolveReserveTokens(options);
  if (reserveTokens === undefined) return ratioThreshold;
  return Math.min(ratioThreshold, options.contextWindowTokens - reserveTokens);
}

function resolveReserveTokens(options: CompactionOptions): number | undefined {
  const reserveTokens =
    options.reserveTokens ??
    (options.reserveRatio === undefined
      ? undefined
      : options.contextWindowTokens * options.reserveRatio);
  if (reserveTokens === undefined || !Number.isFinite(reserveTokens)) return undefined;
  return Math.min(options.contextWindowTokens, Math.max(0, reserveTokens));
}

function snapToUserBoundary(messages: Message.WithParts[], naturalCutoff: number): number {
  for (let index = naturalCutoff; index >= 0; index -= 1) {
    if (messages[index]?.info.role === "user") return index;
  }
  throw new CompactionBoundaryError(
    "no valid compaction boundary: the kept window would start with an assistant message and no summary user message anchors it (onSummarize unset); refusing to commit",
  );
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
