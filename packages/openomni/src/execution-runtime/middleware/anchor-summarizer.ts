import type { Message } from "@openomni/protocol";

/**
 * The anchored-summarization strategy (compaction-design L2): section
 * structure and merge rules live here, in the product, because prompt text
 * is opinion — the agent core only threads the anchor and owns the
 * exclusions (user messages and prior anchor renders never reach us).
 *
 * Shape adopted from senpi's shipped compaction contract: a persistent
 * sectioned checkpoint the summarizer must populate or explicitly leave
 * empty ("structure forces preservation"), updated by incremental merge —
 * PRESERVE existing content, ADD from the new span, move Progress items as
 * they complete — never regenerated from scratch.
 */
export type CompletionFn = (prompt: string) => Promise<string>;

const SECTION_TEMPLATE = `## Goal
[What is being worked toward. Multiple items allowed.]

## Constraints & Preferences
- [Standing constraints or requirements observed in the work]
- [Or "(none)"]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Blockers, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Timeline & Facts
- [YYYY-MM-DD — dated events, facts, commitments, and statements worth recalling later. One line per fact, every line anchored to its absolute date. When a speaker dates an event themselves ("in 2019", "when I was 20", "last spring"), record THAT stated time — the event's own date, not the message's. In this section completeness beats brevity: never drop a dated fact to save space.]
- [Or "(none)"]

## Next Steps
1. [Ordered next actions]

## Critical Context
- [Data, paths, error messages, or references needed to continue]
- [Or "(none)"]

Keep each section concise — except Timeline & Facts, where completeness wins. Preserve exact file paths, function names, error messages, dates, names, and numbers. Resolve relative time ("yesterday", "last week") against the dated message headers into absolute dates — never carry a relative time expression into the checkpoint.`;

const CREATE_PROMPT = `The messages in <conversation> are assistant/tool activity to checkpoint. Produce a structured context checkpoint another LLM will use to continue the work. Do NOT continue the conversation; output ONLY the checkpoint.

Use this EXACT format:

${SECTION_TEMPLATE}`;

const UPDATE_PROMPT = `The messages in <conversation> are NEW assistant/tool activity to merge into the existing checkpoint in <previous-summary>. RULES:
- PRESERVE all information from the previous checkpoint
- ADD new progress, decisions, and context from the new messages
- MOVE Progress items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" for what was accomplished
- Remove an item only when it is clearly no longer relevant
Do NOT continue the conversation; output ONLY the updated checkpoint.

Use this EXACT format:

${SECTION_TEMPLATE}`;

/**
 * Compact model-facing rendering of the cut span. User messages are the
 * core's job to exclude; skipping them here too is defense in depth — a
 * summarizer must never see paraphrasable user text.
 */
export function serializeSpanForSummary(messages: readonly Message.WithParts[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.info.role === "user") continue;
    // #737: every block is dated from the recorded creation time, so the
    // summarizer can anchor facts to absolute dates (its template demands
    // it) — a summary that says "yesterday" is stale the day it is written.
    const date = new Date(message.info.time.created).toISOString().slice(0, 10);
    for (const part of message.parts) {
      if (part.type === "text") {
        lines.push(`[assistant — ${date}]\n${part.text}`);
      } else if (part.type === "tool") {
        const output =
          part.state.status === "completed" ? part.state.output : `(status: ${part.state.status})`;
        lines.push(`[tool ${part.tool} call ${part.callID} — ${date}]\n${output}`);
      }
    }
  }
  return lines.join("\n\n");
}

/**
 * Builds the `onSummarize` strategy for the core's compaction options from
 * a plain completion function. D7: hosts wire `complete` to the run's own
 * model — a cheaper summarizer degrades every downstream turn. Callers
 * should cache-isolate the completion (summaries are one-shot; senpi ships
 * cacheRetention "none").
 */
export function anchorSummarizer(
  complete: CompletionFn,
): (messages: Message.WithParts[], previousAnchor?: string) => Promise<string> {
  return async (messages, previousAnchor) => {
    const conversation = serializeSpanForSummary(messages);
    const prompt =
      previousAnchor === undefined
        ? `<conversation>\n${conversation}\n</conversation>\n\n${CREATE_PROMPT}`
        : `<conversation>\n${conversation}\n</conversation>\n\n<previous-summary>\n${previousAnchor}\n</previous-summary>\n\n${UPDATE_PROMPT}`;
    return complete(prompt);
  };
}
