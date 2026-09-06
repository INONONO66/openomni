/**
 * DESIGN.md 7 — State. A status word is TEXT. The word is the readout, and it
 * is never replaced by a shape: no badge, no colour-coded pill, no `✓`/`✗`
 * standing in for a sentence a reader would otherwise be able to read aloud.
 *
 * A drawn dot may now PRECEDE that word, and the distinction is the whole
 * reason it is allowed. The rejected pattern is a glyph SUBSTITUTING for a
 * word — `●` meaning "running", which forces the reader to learn a legend. Here
 * the word never leaves, and the dot is a drawn element rather than a character
 * from the font: it is "TUI form, GUI substance" applied to status, the same
 * law the tree connectors already follow. The dot makes a status column
 * scannable at a glance down the sidebar; the word makes it unambiguous when
 * read. Removing either one would break a different reader.
 *
 * The tonal rule this primitive owns: exactly ONE tier is a claim about right
 * now, and only that tier takes the accent. Everything else recedes into the
 * muted ramp, because a finished thing should not compete with a live one for
 * attention.
 *
 * What it deliberately does NOT own is the vocabulary. It knows nothing about
 * run states, sessions, or the kernel — the surface passes the word and says
 * which tier it belongs to. Hardcoding `running | waiting | done | interrupted`
 * here would put the app's domain union in the design system and duplicate a
 * type the app already declares; a second copy of a union is a second place for
 * it to drift.
 */
import { useId } from "react";
import { UI_NAMES } from "../names";

export type StateTier = "live" | "attention" | "settled";

const TONE: Record<StateTier, string> = {
  /** The only tier that gets the system's one chroma. */
  live: "text-accent",
  attention: "text-fg-subtle",
  settled: "text-fg-faint",
};

/**
 * The four shapes a status dot can take. This is a SHAPE vocabulary, not a
 * status vocabulary — `ring` does not mean "waiting", it means "hollow circle".
 * The surface maps its own domain union onto these, so the design system still
 * owns no run states (see the note above), and a new app status that happens to
 * be shaped like a ring costs nothing here.
 *
 * Each shape is distinguishable without colour, which is what makes the column
 * survive both themes and a reader who cannot separate the accent from the
 * faint ramp:
 *
 *   - `pulse`  filled, accent, slowly breathing — the live claim
 *   - `ring`   hollow — an outline reads as "not yet filled in", waiting
 *   - `filled` solid, quiet — closed and settled
 *   - `slashed` struck through — the universal mark for cancelled
 */
export type StatusShape = "pulse" | "ring" | "filled" | "slashed";

/**
 * A drawn 6px status mark in a FIXED 2ch column.
 *
 * The column is why this is a primitive rather than three lines inside each
 * caller. Every status dot in the system reserves exactly the same width
 * whether or not it renders anything, so status words start on one x-position
 * down a sidebar and down a transcript. Without that reservation a `running`
 * row and a `done` row indent differently by a pixel or two and the column
 * develops a wobble that reads as sloppiness long before a reader can name it.
 *
 * 2ch, expressed in the mono face's own advance width, because the surfaces
 * this sits on are mono ledgers: the dot occupies one character cell plus its
 * separating space, so it lands on the same grid the text does instead of
 * pushing the row off it.
 *
 * `aria-hidden`, unconditionally. The dot is a redundant visual encoding of the
 * word sitting immediately beside it — announcing it would make a screen reader
 * say the status twice, once as a meaningless "image".
 */
export function StatusDot({
  shape,
  tier,
}: {
  readonly shape: StatusShape;
  readonly tier: StateTier;
}) {
  // A document-unique id per instance. Several interrupted sessions can be on
  // screen at once, and SVG masks resolve by id globally — a shared literal
  // would make every slashed dot after the first reference the first one's
  // mask, which silently works until one of them is unmounted.
  const maskId = `status-slash-${useId()}`;

  return (
    <span
      aria-hidden="true"
      className={`inline-flex w-[2ch] shrink-0 items-center justify-start ${TONE[tier]}`}
      // The wrapper is part of the drawn mark, not text around it: it reserves
      // the 2ch cell and holds the tone the SVG inherits through
      // `currentColor`, and it typesets nothing. Saying so explicitly is what
      // lets the type-level gate tell a drawn cell from a span that forgot its
      // size — the same claim `data-work-spine` and `data-tree-connector` make.
      data-drawn-mark=""
      data-ui={UI_NAMES.StatusDot}
    >
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden decoration; the status word beside it is the readout */}
      <svg
        aria-hidden
        className={shape === "pulse" ? "status-dot-pulse" : undefined}
        data-status-dot={shape === "pulse" ? "running" : shape}
        fill="none"
        height="6"
        viewBox="0 0 6 6"
        width="6"
      >
        {/* r=2.5 with a 1px stroke, not r=3: a stroke straddles the path, so a
            circle drawn at the full radius would paint half its stroke outside
            the 6px box and be clipped flat on four sides.

            `slashed` is a FILLED dot that is then struck, not an empty one. An
            earlier pass drew it hollow AND unstroked, which left a bare
            diagonal floating in the column with no dot under it — it read as a
            stray mark rather than as a cancelled state, and it broke the
            column's rhythm because every other row had a round mark at that x.
            The slash has to negate something visible to mean "stopped". */}
        <circle
          cx="3"
          cy="3"
          fill={shape === "ring" ? "none" : "currentColor"}
          mask={shape === "slashed" ? `url(#${maskId})` : undefined}
          r={shape === "ring" ? 2 : 2.5}
          stroke={shape === "ring" ? "currentColor" : "none"}
          strokeWidth="1"
        />
        {/* The slash is DRAWN across the dot rather than being a `/` character
            set beside it, so it strikes the mark it negates — the geometry says
            "this one, cancelled" without the reader parsing a symbol. It runs
            corner to corner past the circle's edge so the cut is unmistakable
            at 6px.

            The cut is a MASK rather than a line painted in the surface colour.
            A background-toned gap would have to know which surface the dot
            landed on — `bg` in the transcript, `sunken` in the sidebar, `raised`
            on a selected row — and picking one paints a visibly wrong-toned
            notch on the other two (1.21:1 off on a selected row in dark). A
            mask removes the fill instead of covering it, so the strike is
            correct on every surface without the primitive knowing any of
            them. */}
        {shape === "slashed" ? (
          <>
            <mask id={maskId}>
              <rect fill="white" height="6" width="6" x="0" y="0" />
              <path
                d="M0.75 5.25 L5.25 0.75"
                stroke="black"
                strokeLinecap="round"
                strokeWidth="2"
              />
            </mask>
            <path
              d="M0.75 5.25 L5.25 0.75"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1"
            />
          </>
        ) : null}
      </svg>
    </span>
  );
}

export function State({ label, tier }: { readonly label: string; readonly tier: StateTier }) {
  return (
    // `Row.Status` rather than `State`: the word is what a ROW says about
    // itself, and that is the address the Owner reaches for when they mean the
    // second line of a session row. The component keeps its own name because
    // `State` is what it is; `Row.Status` is where it lives.
    <span
      className={`shrink-0 font-mono text-micro ${TONE[tier]}`}
      data-state={label}
      data-ui={UI_NAMES.RowStatus}
    >
      {label}
    </span>
  );
}
