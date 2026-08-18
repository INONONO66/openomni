import type { Message } from "@openomni/protocol";
import { Session } from "@openomni/session";

/**
 * Anchor render enrichment (compaction-design L6, #716). Everything here is
 * DETERMINISTIC — derived from the session store (the ledger's projection)
 * and from the verbatim history the seam received. The summarizer never
 * contributes a byte to these sections: delegating file tracking to
 * summarization is the one category every published probe evaluation fails
 * (2.19–2.45/5, Factory's own numbers), and paraphrased user text is the
 * loss class this whole design exists to prevent.
 *
 * Quote lifetime honesty (#727 review F5): dropped-user quotes are derived
 * from the seam's in-run history and live exactly one epoch — the next cut
 * drops this anchor's render. Long-term carriage of dropped content is the
 * summarizer's merge (Constraints section) and the store's originals, not
 * these quotes.
 *
 * Identity note: decoration touches only the part TEXT (the model-facing
 * render). The metadata record — `compactionAnchor`, `anchorBody`,
 * `keptWindow` — is untouched, so anchor identity, merge threading, and
 * hydration all see exactly what they saw before decoration.
 */

const FILE_READ_TOOLS = new Set(["read", "glob", "grep.search"]);
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);
const MAX_TABLE_ROWS = 40;
const MAX_TABLE_CHARS = 2_000;
const MAX_QUOTE_CHARS = 8_000;
const MAX_GOAL_EXCERPT_CHARS = 2_000;
/** Below this reclaim there is nothing worth spending on decoration. */
const MIN_RECLAIM_FOR_DECORATION_CHARS = 400;

/**
 * The decoration budget is BOUND TO THE RECLAIM (#727 review F1): the core's
 * progress guard compared sizes BEFORE decoration, so an unbounded render
 * grow-back could double a guard-passing window (empirically shown). Total
 * decoration is capped at half the reclaimed chars — the applied window
 * stays strictly smaller than the pre-cut window by at least reclaim/2.
 */
export function decorationBudget(beforeChars: number, afterChars: number): number {
  const reclaimed = beforeChars - afterChars;
  if (reclaimed < MIN_RECLAIM_FOR_DECORATION_CHARS) return 0;
  return Math.floor(reclaimed / 2);
}

/** Same content classes the core's progress guard weighs. */
export function contentChars(messages: readonly Message.WithParts[]): number {
  let chars = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text") chars += part.text.length;
      else if (part.type === "tool" && part.state.status === "completed") {
        chars += part.state.output.length;
      }
    }
  }
  return chars;
}

export interface ArtifactTable {
  readonly read: readonly string[];
  readonly modified: readonly string[];
  readonly truncated: boolean;
}

function pathOf(input: Record<string, unknown>): string | undefined {
  const path = input.path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

/**
 * Mechanical file-state derivation: scan the session's recorded tool parts.
 * No LLM, no inference — a file is listed because a recorded call touched
 * it. Sets are insertion-ordered (first touch first), modified wins over
 * read for display (a written file's read history is implied).
 */
export function deriveArtifactTable(sessionId: string): ArtifactTable {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const info of Session.getMessages(sessionId)) {
    for (const part of Session.getParts(info.id)) {
      if (part.type !== "tool" || part.state.status !== "completed") continue;
      const path = pathOf(part.state.input);
      if (path === undefined) continue;
      if (FILE_WRITE_TOOLS.has(part.tool)) modified.add(path);
      else if (FILE_READ_TOOLS.has(part.tool)) read.add(path);
    }
  }
  for (const path of modified) read.delete(path);
  const truncated = read.size + modified.size > MAX_TABLE_ROWS;
  const budgetRead = [...read].slice(0, Math.max(0, MAX_TABLE_ROWS - modified.size));
  return {
    read: budgetRead,
    modified: [...modified].slice(0, MAX_TABLE_ROWS),
    truncated,
  };
}

function userTexts(messages: readonly Message.WithParts[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.info.role !== "user") continue;
    // Anchor renders and policy-injected nudges are user-roled; neither is
    // user speech (#727 review F4 — a budget banner recited as "the user's
    // goal" is worse than no recitation).
    if (
      message.parts.some(
        (part) =>
          part.type === "text" &&
          (part.metadata?.compactionAnchor === true || part.metadata?.policyInjected === true),
      )
    ) {
      continue;
    }
    for (const part of message.parts) {
      if (part.type === "text") texts.push(part.text);
    }
  }
  return texts;
}

export interface AnchorDecoration {
  readonly artifacts: ArtifactTable;
  /** Verbatim user texts dropped from the window by the preserve budget. */
  readonly droppedQuotes: readonly string[];
  readonly droppedBeyondQuoteBudget: number;
  /** The newest surviving user text — restated verbatim at the render tail. */
  readonly goal: string | undefined;
}

/**
 * What the decoration will say, computed from the seam's own inputs: the
 * pre-cut history (frozen dispatch clone) vs the rebuilt window. Dropped
 * user text = present before, absent after — quoted verbatim, newest-first,
 * within a fixed quote budget; the remainder is counted, never paraphrased.
 */
export function planDecoration(
  sessionId: string,
  before: readonly Message.WithParts[],
  after: readonly Message.WithParts[],
): AnchorDecoration | undefined {
  const budget = decorationBudget(contentChars(before), contentChars(after));
  if (budget === 0) return undefined;

  // Multiset diff (#727 review F5): the same text said twice is two
  // messages — a set would treat the dropped twin as surviving.
  const survivingCounts = new Map<string, number>();
  const surviving = userTexts(after);
  for (const text of surviving) {
    survivingCounts.set(text, (survivingCounts.get(text) ?? 0) + 1);
  }
  const dropped: string[] = [];
  for (const text of userTexts(before)) {
    const remaining = survivingCounts.get(text) ?? 0;
    if (remaining > 0) survivingCounts.set(text, remaining - 1);
    else dropped.push(text);
  }

  // Every section is budgeted, and the total stays within the reclaim-bound
  // budget (#727 review F1/F2 — no first-quote exemption: a quote that does
  // not fit is counted, never silently kept).
  const quoteBudget = Math.min(MAX_QUOTE_CHARS, Math.floor(budget / 2));
  const quotes: string[] = [];
  let quoteChars = 0;
  let beyond = 0;
  for (let index = dropped.length - 1; index >= 0; index -= 1) {
    const text = dropped[index];
    if (text === undefined) continue;
    if (quoteChars + text.length > quoteBudget) {
      beyond += 1;
      continue;
    }
    quotes.unshift(text);
    quoteChars += text.length;
  }

  const goalBudget = Math.min(MAX_GOAL_EXCERPT_CHARS, Math.floor(budget / 4));
  const newestUser = surviving.at(-1);
  const goal =
    newestUser === undefined
      ? undefined
      : newestUser.length <= goalBudget
        ? newestUser
        : `${newestUser.slice(0, goalBudget)}
(excerpt — full text is in the window)`;

  return {
    artifacts: deriveArtifactTable(sessionId),
    droppedQuotes: quotes,
    droppedBeyondQuoteBudget: beyond,
    goal,
  };
}

function quoteBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Appends the deterministic sections to the anchor's model-facing render. */
export function decorateAnchorRender(render: string, decoration: AnchorDecoration): string {
  const sections: string[] = [render];
  const { artifacts } = decoration;
  if (artifacts.read.length > 0 || artifacts.modified.length > 0) {
    const lines = [
      "## Files (recorded builtin file-tool calls; MCP and bash are not tracked here)",
    ];
    if (artifacts.modified.length > 0) lines.push(`modified: ${artifacts.modified.join(", ")}`);
    if (artifacts.read.length > 0) lines.push(`read: ${artifacts.read.join(", ")}`);
    if (artifacts.truncated) lines.push("(list truncated)");
    const block = lines.join("\n");
    sections.push(
      block.length > MAX_TABLE_CHARS
        ? `${block.slice(0, MAX_TABLE_CHARS)}\n(table truncated)`
        : block,
    );
  }
  if (decoration.droppedQuotes.length > 0 || decoration.droppedBeyondQuoteBudget > 0) {
    const lines = ["## Earlier user messages no longer in the window (verbatim)"];
    for (const quote of decoration.droppedQuotes) lines.push(quoteBlock(quote));
    if (decoration.droppedBeyondQuoteBudget > 0) {
      lines.push(`(${decoration.droppedBeyondQuoteBudget} more not quoted — quote budget)`);
    }
    sections.push(lines.join("\n"));
  }
  if (decoration.goal !== undefined) {
    sections.push(
      `## Current goal (latest user message; full text is in the window)\n${quoteBlock(decoration.goal)}`,
    );
  }
  return sections.join("\n\n");
}
