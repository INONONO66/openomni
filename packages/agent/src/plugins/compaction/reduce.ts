import type { Message } from "@openomni/protocol";

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
 * reads them again. Errored outputs are out of scope: they project as
 * `Error: <message>`, already short in the cases that matter.
 *
 * The marker carries the part's `callID`, so elision is a pointer, not a
 * dead end (compaction-design L1): the original output stays recorded in
 * the session's append-only transcript facts, which compaction never
 * rewrites — `run.replace_messages` touches only the in-run history. A
 * product-side tool resolves the id back to the recorded output; the id in
 * the marker is a fact about the elided part, not a tool name, so the core
 * stays free of domain strings.
 *
 * Termination is structural, not configurational: an output is elided only
 * when its replacement is strictly shorter, so every pass shrinks what it
 * touches and a fixed point exists for every config — including ones where
 * marker + head would not fit under `minOutputChars` (those outputs are
 * simply left alone, and adversarial review showed the alternative: marker
 * stacking that reports negative yield as positive, forever). `elidedChars`
 * is the net shrink, not the original length. Part identities are
 * preserved: this rewrites a field of the same part, it does not mint new
 * parts.
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
    // User-role messages are never rewritten, tool parts included: the
    // verbatim-preservation invariant (compaction-design principle 2) is a
    // property of the whole message, not just its text parts.
    if (message.info.role === "user") return message;
    let touched = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return part;
      if (part.state.output.length <= options.minOutputChars) return part;
      const output = elidedOutput(part.state.output, options.keepHeadChars, part.callID);
      if (output.length >= part.state.output.length) return part;
      elidedChars += part.state.output.length - output.length;
      touched = true;
      return { ...part, state: { ...part.state, output } };
    });
    return touched ? { ...message, parts } : message;
  });

  return elidedChars === 0
    ? { messages: [...messages], elidedChars: 0 }
    : { messages: reduced, elidedChars };
}

function elidedOutput(output: string, keepHeadChars: number, callID: string): string {
  return `[output elided by compaction: ${output.length} chars; recall: ${callID}]\n${output.slice(0, keepHeadChars)}`;
}
