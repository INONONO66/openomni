import { UI_NAMES } from "../names";

/**
 * DESIGN.md 9 — the transcript's addressable gutter.
 *
 * Every row in the column has a stable address, and this is the affordance that
 * exposes it: a faint right-aligned number in the left gutter, invisible until
 * the row is hovered or the number itself is focused, that copies the anchor
 * and sets the location hash when clicked.
 *
 * It is deliberately the SAME treatment `GutterLine` gives a line of code —
 * faint, tabular, `user-select: none`, right-aligned into a fixed column. A
 * transcript that numbered its prose differently from its code would be saying
 * that a paragraph and a source line are different kinds of addressable thing,
 * and they are not: both are places the Owner points at.
 *
 * Three properties are load-bearing:
 *
 *   - **The anchor is never text in the row.** It rides `data-anchor` on the
 *     row and appears here as a NUMBER, so selecting a paragraph copies the
 *     paragraph. An id printed inline would be in every copy-paste of the
 *     transcript forever.
 *   - **It is `user-select: none`.** Dragging a selection across three
 *     paragraphs must not interleave three row numbers into the clipboard —
 *     the same defect the code gutter was built to avoid.
 *   - **Hidden means invisible, not absent.** It holds its column at rest via
 *     `opacity`, so revealing it shifts nothing. A gutter that mounts on hover
 *     would push every row's text 4ch to the right as the pointer crosses it.
 */
/**
 * The gutter's exact geometry.
 *
 * `4ch` is the mono face's advance, so the reservation is only 4ch if the FACE
 * AND THE SIZE both match — the same 4ch set at a different font-size is a
 * different number of pixels.
 *
 * This used to be EXPORTED, so a work-group header could hold the same column
 * open without drawing a number in it. That header is gone with the spines and
 * the right-aligned status columns, and nothing else ever needed the geometry,
 * so it is local again: an exported constant with one in-file caller is an
 * invitation to reserve this column from somewhere new.
 */
const ANCHOR_GUTTER_WIDTH = "w-[4ch] shrink-0 pe-cell font-mono text-micro";

export function AnchorGutter({
  anchor,
  row,
  onCopy,
  className = "",
}: {
  /** The stable address this control copies: `t3.7`. */
  readonly anchor: string;
  /** The visible number — the row's index within its turn. */
  readonly row: number;
  /** Copy the anchor and address the row. The surface owns both effects. */
  readonly onCopy: (anchor: string) => void;
  readonly className?: string;
}) {
  return (
    <button
      aria-label={`copy anchor ${anchor}`}
      className={`focus-ring ${ANCHOR_GUTTER_WIDTH} cursor-default select-none rounded-sm text-right text-fg-faint tabular-nums opacity-0 transition-quiet hover:text-fg-subtle focus-visible:opacity-100 group-hover/anchored:opacity-100 ${className}`}
      data-anchor-gutter={anchor}
      data-ui={UI_NAMES.AnchorGutter}
      onClick={() => onCopy(anchor)}
      type="button"
    >
      {row}
    </button>
  );
}
