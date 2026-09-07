import { UI_NAMES } from "../names";

/**
 * an epoch rule, DRAWN.
 *
 *     ───── compacted · 14:32
 *
 * A real hairline plus a label, marking a boundary in the ledger: a compaction,
 * a resume, a generation change. It is not a separator between turns — routine
 * turns are separated by whitespace, and a full-width line between every pair
 * of rows would put a drawn box back into a system that removed them.
 *
 * The rule was five `─` characters. It is now a real `<hr>` whose stroke is a
 * border, for three reasons the characters could not satisfy:
 *
 *   - **The stroke is one device pixel at any density.** A `─` glyph is an
 *     outline the rasterizer antialiases; at 1x it renders as a soft two-pixel
 *     grey band that reads lighter than the hairline beside it in the same
 *     column. A border does not.
 *   - **The label sits IN the line, not after it.** Like a fieldset legend: the
 *     rule runs to the label, stops, and resumes on the far side, which is what
 *     makes a boundary read as spanning the column instead of as a bullet with
 *     a decoration in front of it.
 *   - **It is a control.** A boundary is a place in the ledger, so it is worth
 *     jumping to. With an `onJump` the whole rule becomes a real focusable
 *     button; without one it stays inert and the `<hr>` alone carries it.
 *
 * The semantics ride the `<hr>` rather than `role="separator"` on a div: `<hr>`
 * already MEANS "thematic break", so assistive technology gets the boundary for
 * free and no ARIA is spent restating it. The label stays real readable text
 * instead of an `aria-label` copy of a visible string — two strings that drift.
 *
 * Everything renders faint and none of it takes the accent: the boundary is a
 * fact about the transcript, not an event competing with the turns around it.
 */
export function EpochRule({
  label,
  meta,
  onJump,
  className = "",
}: {
  /** What boundary this is: `compacted`, `resumed`, `context restored`. */
  readonly label: string;
  /** One qualifying fact — a time, a count. Tabular, one step quieter. */
  readonly meta?: string;
  /**
   * Scroll the ledger to this boundary. Present only where there is somewhere
   * to go: a rule with no destination must not look like a control, so the
   * hover and focus treatments come with the handler rather than by default.
   */
  readonly onJump?: () => void;
  readonly className?: string;
}) {
  const content = (
    <>
      {/* The lead-in: a short fixed run, the drawn equivalent of the five cells
          the glyph version printed. `w-8` is 32px — the row step — so the rule
          starts on the same grid every other element in the column lands on. */}
      <Hairline className="w-8 shrink-0" />
      {/* 2px of vertical padding on the LABEL, not on the rule's container. The
          label is what the line runs into, so the breathing room has to belong
          to the label's own box or the stroke passes too close to its
          descenders and the two read as one smudged element. It costs no row
          height — the rule's height is set by its tallest child either way. */}
      <span className="shrink-0 py-0.5 font-mono text-fg-faint text-meta">{label}</span>
      {meta !== undefined && (
        <span className="shrink-0 py-0.5 font-mono text-fg-faint text-micro tabular-nums">
          {meta}
        </span>
      )}
      {/* The run-out fills the remaining measure, so the boundary spans the
          column and the label reads as sitting IN the line. */}
      <Hairline className="min-w-0 flex-1" />
    </>
  );

  // The rule is bounded by the reading measure, like the prose it sits between.
  // A run-out that flexes to whatever container it lands in draws a line to the
  // window's edge on a wide surface, which is the full-width divider this rule
  // exists to not be.
  const bounds = `max-w-measure ${className}`;

  if (onJump === undefined) {
    return (
      <div
        className={`flex items-center gap-2 ${bounds}`}
        data-epoch-rule
        data-ui={UI_NAMES.EpochRule}
      >
        <hr aria-hidden className="m-0 h-0 w-0 border-0 p-0" />
        {content}
      </div>
    );
  }

  return (
    <div className={`flex ${bounds}`} data-epoch-rule data-ui={UI_NAMES.EpochRule}>
      <hr aria-hidden className="m-0 h-0 w-0 border-0 p-0" />
      <button
        className="focus-ring group/epoch -mx-inset flex min-w-0 flex-1 items-center gap-2 rounded-md px-inset py-1 text-left transition-quiet hover:bg-hover"
        onClick={onJump}
        type="button"
      >
        {content}
      </button>
    </div>
  );
}

/**
 * The stroke itself: a top border on a zero-height box.
 *
 * A border rather than a background, and zero height rather than `h-px`,
 * because a 1px background box is subject to layout rounding at fractional
 * device ratios and can vanish or double; a border on a box edge is snapped by
 * the compositor at every density. `currentColor` inherits the faint tone from
 * the row, so the stroke can never drift away from the label beside it.
 */
function Hairline({ className = "" }: { readonly className?: string }) {
  return <span aria-hidden className={`h-0 border-fg-faint border-t ${className}`} />;
}
