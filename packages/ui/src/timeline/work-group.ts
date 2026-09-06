import type { ToolStatus, TranscriptTool } from "./model";

/**
 * When a run of tool calls folds, and what a fold is never allowed to hide.
 *
 * A transcript that prints forty `read` receipts has spent the reader's whole
 * column on evidence nobody asked for. A transcript that hides a call which is
 * still running, or one that failed, has hidden the only rows that were news.
 * Those two pressures are the entire design here, and they resolve into one
 * rule: fold by DEFAULT once a group is long enough to be scenery, and exempt
 * every row that is making a claim about right now.
 */

/**
 * Four. Three rows are still a list the eye takes in whole; the fourth is where
 * a run starts reading as a wall and the summary becomes the better line.
 */
export const COLLAPSE_AFTER = 4;

/**
 * The statuses a fold may never hide.
 *
 * Everything except `done`. A settled successful call is evidence — it can be
 * asked for. Every other state is either unfinished or went wrong, and a
 * summary line saying `6 tools` while one of them is silently waiting for the
 * Owner is the exact failure this rule exists to prevent.
 */
const LOUD: ReadonlySet<ToolStatus> = new Set<ToolStatus>([
  "running",
  "waiting",
  "failed",
  "denied",
]);

export function isLoud(call: TranscriptTool): boolean {
  return call.status !== undefined && LOUD.has(call.status);
}

/** What a collapsed group prints instead of its rows. */
export interface GroupSummary {
  /** `6 tools` — the count of every call, including the ones still shown. */
  readonly total: number;
  /** `4 read · 2 edit`, most frequent first, then alphabetical for stability. */
  readonly byTool: readonly { readonly tool: string; readonly count: number }[];
  /** The rows the fold may not hide, in their original order. */
  readonly pinned: readonly TranscriptTool[];
}

/** Whether this group folds at rest. */
export function collapses(calls: readonly TranscriptTool[]): boolean {
  return calls.length >= COLLAPSE_AFTER;
}

/**
 * The summary for a folded group.
 *
 * The tool breakdown is sorted by count and then by name rather than left in
 * arrival order, because this line is READ AS A TALLY: "mostly reads, a couple
 * of edits". Arrival order would reorder the same tally between two renders of
 * the same session and make the line un-scannable.
 */
export function summarize(calls: readonly TranscriptTool[]): GroupSummary {
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);

  const byTool = [...counts]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));

  return { total: calls.length, byTool, pinned: calls.filter(isLoud) };
}

/**
 * The summary as its one line: `6 tools · 4 read · 2 edit · 1.8s`.
 *
 * The elapsed total is appended by the caller when it has one, because a group
 * with a call still running has no total to report and a line that printed one
 * anyway would be claiming the run finished.
 */
export function summaryLabel(summary: GroupSummary, elapsed?: string): string {
  const parts = [
    `${summary.total} ${summary.total === 1 ? "tool" : "tools"}`,
    ...summary.byTool.map(({ tool, count }) => `${count} ${tool}`),
  ];
  if (elapsed !== undefined) parts.push(elapsed);
  return parts.join(" \u00b7 ");
}
