/**
 * DESIGN.md 9 — addressable lines.
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

/**
 * Parse an anchor back out of a `location.hash`.
 *
 * Returns `null` for anything that is not exactly this shape, including a hash
 * that merely starts with one (`#t1.2extra`): a partial match would let an
 * unrelated fragment focus a row, and a focus ring appearing on a random line
 * is worse than the hash doing nothing.
 */
export function parseAnchor(hash: string): { readonly turn: number; readonly row: number } | null {
  const match = /^#?t(\d+)\.(\d+)$/.exec(hash);
  if (match === null) return null;

  const turn = Number(match[1]);
  const row = Number(match[2]);
  // 0 is not a valid index in either position, and a leading-zero form like
  // `t01.2` would parse to the same anchor as `t1.2` while being a different
  // string — two hashes for one row, so the copied link and the rendered id
  // could disagree.
  if (turn < 1 || row < 1) return null;
  if (anchorId(turn, row) !== stripHash(hash)) return null;

  return { turn, row };
}

function stripHash(hash: string): string {
  return hash.startsWith("#") ? hash.slice(1) : hash;
}

/**
 * A monotonic row counter for one turn.
 *
 * Rendering walks the turn's blocks in order and asks for the next number, so
 * the count follows the RENDERED sequence rather than the data's shape — a
 * paragraph that renders as three rows takes three anchors, and a collapsed
 * work group's hidden rows still consume theirs, so expanding a group never
 * renumbers the rows below it. An anchor that changes when a disclosure opens
 * is an anchor nobody can cite.
 */
export function rowCounter(): () => number {
  let row = 0;
  return () => {
    row += 1;
    return row;
  };
}
