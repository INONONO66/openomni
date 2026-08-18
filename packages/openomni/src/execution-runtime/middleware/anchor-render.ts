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
 * Identity note: decoration touches only the part TEXT (the model-facing
 * render). The metadata record — `compactionAnchor`, `anchorBody`,
 * `keptWindow` — is untouched, so anchor identity, merge threading, and
 * hydration all see exactly what they saw before decoration.
 */

const FILE_READ_TOOLS = new Set(["read", "glob", "grep.search"]);
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);
const MAX_TABLE_ROWS = 40;
const DROPPED_QUOTE_BUDGET_CHARS = 8_000;

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
    // Anchor renders are user-roled; they are not user speech.
    if (
      message.parts.some((part) => part.type === "text" && part.metadata?.compactionAnchor === true)
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
): AnchorDecoration {
  const afterTexts = new Set(userTexts(after));
  const dropped = userTexts(before).filter((text) => !afterTexts.has(text));
  const quotes: string[] = [];
  let quoteChars = 0;
  let beyond = 0;
  for (let index = dropped.length - 1; index >= 0; index -= 1) {
    const text = dropped[index];
    if (text === undefined) continue;
    if (quoteChars + text.length > DROPPED_QUOTE_BUDGET_CHARS && quotes.length > 0) {
      beyond += 1;
      continue;
    }
    quotes.unshift(text);
    quoteChars += text.length;
  }
  const surviving = userTexts(after);
  return {
    artifacts: deriveArtifactTable(sessionId),
    droppedQuotes: quotes,
    droppedBeyondQuoteBudget: beyond,
    goal: surviving.at(-1),
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
    const lines = ["## Files (recorded tool calls, not summarized)"];
    if (artifacts.modified.length > 0) lines.push(`modified: ${artifacts.modified.join(", ")}`);
    if (artifacts.read.length > 0) lines.push(`read: ${artifacts.read.join(", ")}`);
    if (artifacts.truncated) lines.push("(list truncated)");
    sections.push(lines.join("\n"));
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
      `## Current goal (verbatim, latest user message)\n${quoteBlock(decoration.goal)}`,
    );
  }
  return sections.join("\n\n");
}
