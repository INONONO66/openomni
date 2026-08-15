import type { Message, Tool } from "@openomni/protocol";

export interface ToolOutputElision {
  /** Outputs at or below this length are left alone — nothing worth reclaiming. */
  readonly minOutputChars: number;
  /** How much of the head survives as an excerpt, so the record still says what happened. */
  readonly keepHeadChars: number;
}

interface ReductionResult {
  readonly messages: Message.WithParts[];
  readonly elidedChars: number;
}

/**
 * Deterministic, no-LLM reduction: rewrite the completed tool outputs of
 * messages older than the protected tail to a sized elision marker plus a
 * head excerpt. The model projection resends `state.output` verbatim on
 * every call, so old bulky outputs dominate the window long after anything
 * reads them again.
 *
 * Runs before the cut, not instead of it: elision reclaims tokens without
 * dropping any message, so the lossy boundary-snap cut is reached only when
 * there is nothing left to elide. Idempotent by construction — an elided
 * output is shorter than any sane `minOutputChars`, so a second pass finds
 * nothing. Part identities are preserved: this rewrites a field of the same
 * part, it does not mint new parts.
 */
export function elideToolOutputs(
  messages: readonly Message.WithParts[],
  protectRecentMessages: number,
  options: ToolOutputElision,
): ReductionResult {
  const cutoff = messages.length - protectRecentMessages;
  let elidedChars = 0;

  const reduced = messages.map((message, index) => {
    if (index >= cutoff) return message;
    let touched = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return part;
      if (part.state.output.length <= options.minOutputChars) return part;
      elidedChars += part.state.output.length;
      touched = true;
      return { ...part, state: elidedState(part.state, options.keepHeadChars) };
    });
    return touched ? { ...message, parts } : message;
  });

  return elidedChars === 0
    ? { messages: [...messages], elidedChars: 0 }
    : { messages: reduced, elidedChars };
}

function elidedState(
  state: Extract<Tool.State, { status: "completed" }>,
  keepHeadChars: number,
): Extract<Tool.State, { status: "completed" }> {
  return {
    ...state,
    output: `[output elided by compaction: ${state.output.length} chars]\n${state.output.slice(0, keepHeadChars)}`,
  };
}
