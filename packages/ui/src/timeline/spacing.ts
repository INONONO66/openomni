/**
 * The transcript's whole vertical structure, as one function.
 *
 * There are no rules, no boxes, and no backgrounds in this column. Every
 * grouping the reader perceives is produced by the size of the gap above a
 * part, so that gap is the layout — which is why it is a pure function over
 * two part kinds rather than a `className` chosen at each call site. A surface
 * that picks its own margins has no rhythm; it has a hundred decisions that
 * agree by luck.
 *
 * Four steps, and the ratios between them are the message:
 *
 *   - **40px between TURNS.** The largest gap in the column, and the only one
 *     that says "a new exchange starts here". It has to beat every gap inside a
 *     turn by enough that the eye finds turn boundaries without reading. It was
 *     28px, which is only 1.75x the pairing gap — close enough that in a shot of
 *     the real column the next `you` read as the tail of the previous answer
 *     rather than as a new exchange. At 40px the boundary is 2.5x the largest
 *     gap inside a turn and the asymmetry is legible without measuring.
 *   - **16px from a user message to its response.** Clearly less than 40, so
 *     the response is bound to the prompt above it rather than floating between
 *     two turns. This is the pairing gap, and it is deliberately UNCHANGED: the
 *     defect was never that a turn read as too loose inside, it was that its
 *     boundary did not read as a boundary.
 *   - **8px between prose and an adjacent tool block.** Work and the sentence
 *     explaining it are one thought; 8px keeps them one visual unit while still
 *     separating two different type voices.
 *   - **6px between paragraphs.** Below the 8px step, so paragraphs of one
 *     answer read as continuous prose and never as separate blocks.
 *
 * The steps are declared here as PIXEL NUMBERS and converted to a class by
 * `spacingClass`, so a test can assert the law numerically without rendering
 * anything, and the rendered column cannot disagree with the asserted one.
 */

/**
 * What a part IS, for spacing purposes only.
 *
 * Deliberately coarser than the node union: spacing does not care whether a
 * tool row failed, and it must not — a gap that changed with status would make
 * the column's rhythm twitch as calls resolve.
 */
export type PartKind = "user" | "prose" | "tools" | "epoch";

/** The four steps, in pixels. The only place these numbers exist. */
export const TURN_GAP = 40;
export const PAIR_GAP = 16;
export const BLOCK_GAP = 8;
export const PARAGRAPH_GAP = 6;

/**
 * The gap above `part`, given what precedes it.
 *
 * `null` for the first part in the column: a leading margin at the top of a
 * scroll region is dead space the reader pays for on every session open.
 */
export function gapAbove(previous: PartKind | null, part: PartKind): number {
  // Nothing above it — no gap to compute.
  if (previous === null) return 0;

  // A user message always opens a turn, so the gap above it is the turn gap
  // regardless of what closed the previous one. This is the rule that makes
  // turn boundaries the loudest whitespace in the column.
  if (part === "user") return TURN_GAP;

  // An epoch is a boundary in the ledger and gets the same air a turn does on
  // both sides, so a compaction never reads as belonging to the turn under it.
  if (part === "epoch" || previous === "epoch") return TURN_GAP;

  // The response to a prompt: bound to it, and visibly tighter than a turn.
  if (previous === "user") return PAIR_GAP;

  // Prose next to prose is one continuous answer.
  if (previous === "prose" && part === "prose") return PARAGRAPH_GAP;

  // Everything left is a voice change inside one turn — prose meeting tools, or
  // tools meeting prose, or a second tool block after a paragraph split one.
  return BLOCK_GAP;
}

/**
 * The four steps as LITERAL class strings, keyed by their pixel value.
 *
 * This table exists because Tailwind scans source text statically: it finds
 * class names it can SEE, and an interpolated `mt-[${gap}px]` is invisible to
 * it. The first cut of this file built the class that way, so all four rules
 * were absent from the compiled stylesheet and every gap in the transcript
 * collapsed to zero — with nothing failing anywhere, because the components
 * emitted exactly the right class names and only the CSS to match them was
 * missing.
 *
 * Writing the classes out is what makes them real. The numbers above stay the
 * single source of the LAW, and this table is checked against them below, so
 * the two cannot drift apart.
 */
const GAP_CLASS: Readonly<Record<number, string>> = {
  [TURN_GAP]: "mt-[40px]",
  [PAIR_GAP]: "mt-[16px]",
  [BLOCK_GAP]: "mt-[8px]",
  [PARAGRAPH_GAP]: "mt-[6px]",
};

/**
 * The gap as a Tailwind margin class.
 *
 * An arbitrary-value class rather than a named spacing token, because these
 * four numbers ARE the transcript's rhythm and exist nowhere else in the
 * system. Routing them through `--spacing-*` would invite a second consumer to
 * re-point them and silently change the reading law.
 */
export function spacingClass(previous: PartKind | null, part: PartKind): string {
  const gap = gapAbove(previous, part);
  if (gap === 0) return "";

  const cls = GAP_CLASS[gap];
  // Unreachable while the table above covers the four constants, and asserted
  // by the tests. Falling back to the interpolated form would reintroduce the
  // exact silent failure this table exists to prevent, so it throws instead.
  if (cls === undefined) throw new Error(`no class for a ${gap}px gap`);
  return cls;
}
