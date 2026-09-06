/**
 * DESIGN.md 5 rule 5 — the one moving element in the system, DRAWN.
 *
 * A 2×3 grid of dots — the braille cell's own geometry — with the lit dot
 * stepping around the ring. It was ten braille CHARACTERS advanced by a CSS
 * `content` cycle; it is now six `<circle>`s whose opacity steps, which fixes
 * what the characters could not:
 *
 *   - **It renders identically everywhere.** Braille is outside most UI faces'
 *     coverage, so the frames fell back to a system face with a different
 *     advance width and a different optical weight — visible in the before
 *     shots as a cell that jitters and reads darker than the text beside it.
 *     Circles are drawn by this system, in this system's tone.
 *   - **It cannot be selected or copied into a log.** A spinner pasted into a
 *     bug report as `⠹` is noise in a transcript that is otherwise all text
 *     that means something.
 *   - **The frame count is a rotation, not a font's sequence.** Six positions
 *     around the ring at a `steps(6)` cycle, so the motion is a discrete
 *     advance rather than a sub-pixel spin of a glyph outline.
 *
 * The three bounds that keep the exception from spreading are unchanged:
 *
 *   1. **Only a user-started, live row may carry it.** Background activity says
 *      the word. A surface full of spinners is the ambient motion the focus
 *      rule exists to prevent.
 *   2. **`prefers-reduced-motion` renders a static dot and the word `running`**
 *      — not a frozen animation. A stopped spinner reads as a hung process, so
 *      the reduced-motion path swaps the readout rather than just stopping the
 *      motion. The swap is CSS, so it tracks the OS setting live with no
 *      listener and cannot desync mid-render.
 *   3. **It animates `opacity` only.** No transform, no layout, no filter — the
 *      cheapest property there is, on six 1px-radius circles.
 *
 * The accessible readout is always the word, and the CALLER supplies it. The
 * dots are `aria-hidden` and the row prints `running` immediately after them in
 * its own voice, so the state is announced identically with motion, without
 * motion, and to a screen reader — without this primitive printing a second
 * copy of a word the row already set.
 *
 * That is why `word` is opt-in rather than built in. A spinner that always
 * carried its own label could not sit inside a sentence, and the transcript's
 * tool row is a sentence: `shell  npm test · running`.
 *
 * The keyframes and the reduced-motion swap live in `styles.css` beside the
 * other motion tokens: this file names a utility, never a duration.
 */
import { UI_NAMES } from "../names";

/**
 * The six dot positions, in stepping order around the cell.
 *
 * A 2×3 grid on a 10-unit box: two columns at x=3.5/6.5, three rows at
 * y=2.5/5/7.5 — the proportions of a braille cell, which is what makes the
 * indicator read as belonging to the same grammar as the rest of the column
 * without being a braille character. The order walks the RING (down the left
 * column, up the right) rather than raster order, so the lit dot travels
 * continuously instead of jumping across the cell.
 */
const DOTS: readonly (readonly [number, number])[] = [
  [3.5, 2.5],
  [3.5, 5],
  [3.5, 7.5],
  [6.5, 7.5],
  [6.5, 5],
  [6.5, 2.5],
];

export function Spinner({
  word,
  className = "",
}: {
  /**
   * The state word, when this spinner stands alone. Omitted where the caller
   * already prints one beside it — the transcript's tool rows do.
   */
  readonly word?: string;
  readonly className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1 ${className}`} data-spinner data-ui={UI_NAMES.Spinner}>
      {/* One cell wide, matching the character column it sits in, so a row does
          not change width when its tool goes live. */}
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden decoration; the word beside it is the name */}
      <svg aria-hidden className="spinner-dots size-3 shrink-0 text-fg-faint" viewBox="0 0 10 10">
        {DOTS.map(([cx, cy], index) => (
          <circle
            cx={cx}
            cy={cy}
            data-dot={index}
            fill="currentColor"
            // biome-ignore lint/suspicious/noArrayIndexKey: position IS identity
            key={index}
            r={1}
            style={{ ["--dot" as string]: String(index) }}
          />
        ))}
      </svg>
      {/* The word IS the state. With reduced motion it becomes visible and the
          dots collapse to a single static mark; otherwise it stays available to
          assistive tech. Where the caller prints its own word there is nothing
          to hide and nothing to reveal, so the element is absent rather than
          empty. */}
      {word !== undefined && (
        <span className="spinner-word font-mono text-fg-faint text-micro">{word}</span>
      )}
    </span>
  );
}
