/**
 * addressable lines.
 *
 * Every row in the transcript — a prompt, a paragraph of the answer, a tool
 * row, a line of code — carries a stable anchor `t<turn>.<row>`. That is what
 * makes a transcript CITABLE: "look at t3.7" is a thing the Owner can say to an
 * agent or paste into a review, and without it the only way to point at a line
 * is to quote it back in full.
 *
 * Two properties are load-bearing and are pinned by tests:
 *
 *   - **The anchor is DATA, never text.** It rides `data-anchor`, so selecting
 *     a paragraph copies the paragraph and not an identifier glued to it. The
 *     visible affordance is a faint gutter number that appears on hover, in the
 *     same left column and the same tone as a code fence's `Gutter` — one
 *     answer to "how does this surface number a line", not two.
 *   - **The numbering is positional and dense.** Row 1 is the first row of the
 *     turn and there are no gaps, so `t3.7` means "the seventh row of turn 3"
 *     and can be counted by a reader looking at the column. Deriving it from an
 *     id or a hash would produce a stable string that means nothing.
 */

/** `t3.7` — turn 3, row 7. Both are 1-based; row 0 does not exist. */
export function anchorId(turn: number, row: number): string {
  return `t${turn}.${row}`;
}
