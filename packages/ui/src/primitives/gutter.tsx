import type { ReactNode } from "react";
import { UI_NAMES } from "../names";

/**
 * DESIGN.md 5 rule 8 — an addressable gutter, DRAWN.
 *
 *     142   let lease = self.lease.acquire().await?;
 *     143 - if lease.generation != self.generation {
 *     144 + if lease.generation < self.generation {
 *
 * A real CSS grid — `auto auto 1fr` — rather than a flex row of padded spans.
 * The number column is `<span>`s with `user-select: none`, so selecting the
 * block copies the CODE and not a column of digits interleaved with it, which
 * is the defect that made a copied fence unusable.
 *
 * The change marker is carried TWICE, on purpose:
 *
 *   - As a **2px bar in the gutter**, drawn immediately left of the line number.
 *     It sits INSIDE the gutter, against the number it qualifies, rather than on
 *     the block's far-left edge: a marker 40px away from the line it marks is a
 *     second column the eye has to associate back, and at the fence's width that
 *     association fails on exactly the long diffs where it matters. Beside the
 *     number the bar and the line are one fixation.
 *   - As the **literal `+`/`-` character**, which is what distinguishes an
 *     addition from a removal and what survives copy. A diff encoded only as
 *     color is unreadable to a red-green colorblind reader, invisible in
 *     grayscale, and lost the moment the block is pasted; the character survives
 *     all three, which is why the hue is a supplement to it and never a
 *     replacement.
 *
 * Both are CHROMATIC, and that is the system's one scoped exception to the
 * single-accent law (DESIGN.md §2). Green-is-added / red-is-removed is the
 * universal diff convention — git's, every review tool's, every editor's — and
 * the reader arrives already trained on it, so an achromatic diff is the one
 * place refusing color makes the surface harder to read than the convention it
 * quotes. The exception is spent on the bar and the sign ONLY. The code text
 * keeps the achromatic syntax ramp, because tinting a whole row would make the
 * diff the loudest region on a text-first surface and would re-encode the
 * meaning in the one channel a colorblind reader cannot use. The optional row
 * tint below is held at 6% alpha for the same reason: it locates the row, it
 * does not carry the claim.
 *
 * The number column is `tabular-nums` and right-aligned so digits form one edge
 * down the block. A ragged gutter is a column of noise the eye re-anchors on at
 * every row.
 *
 * With `onAnchor` the number becomes a real button: clicking a line number
 * anchors it, which is what makes "the fence at 143" a thing the Owner can
 * point at rather than only say. Without a handler it stays inert text, so a
 * gutter with nowhere to go does not pretend to be a control.
 */
export type GutterMark = "add" | "remove" | "context";

/**
 * The literal character, kept beside the drawn tint. A space for context, not
 * an empty string: the column has to hold its width or every context line
 * shifts one character left of the changed ones.
 */
const MARK: Record<GutterMark, string> = {
  add: "+",
  remove: "-",
  context: " ",
};

/**
 * The marker bar's color, and the sign's, per change kind.
 *
 * One record rather than two, because the bar and the sign are ONE signal shown
 * twice and they must never disagree about which kind of change a line is. A
 * context line draws a transparent bar rather than none, so the gutter holds its
 * width and the numbers stay on one right edge — a bar that collapses when
 * absent shifts every unchanged line two pixels left of the changed ones.
 */
const TINT: Record<
  GutterMark,
  { readonly bar: string; readonly sign: string; readonly row: string }
> = {
  add: { bar: "bg-diff-add", sign: "text-diff-add", row: "bg-diff-add/6" },
  remove: { bar: "bg-diff-remove", sign: "text-diff-remove", row: "bg-diff-remove/6" },
  // A context line is not a change, so it takes no hue at all. Absence IS the
  // signal here: if every line were tinted, none would be marked.
  context: { bar: "bg-transparent", sign: "text-fg-faint", row: "" },
};

export function GutterLine({
  number,
  mark = "context",
  anchored = false,
  onAnchor,
  children,
}: {
  readonly number: number;
  readonly mark?: GutterMark;
  /** This line is the one currently anchored — a raised row, no second mark. */
  readonly anchored?: boolean;
  /** Anchor this line. Present only where the surface can actually address it. */
  readonly onAnchor?: (line: number) => void;
  readonly children: ReactNode;
}) {
  const numberClass =
    "select-none text-right font-mono text-fg-faint text-micro tabular-nums tracking-normal";
  const tint = TINT[mark];

  return (
    // Four columns: the marker bar, the number, the sign, the code. The bar is a
    // real grid track rather than a border on the row, which is what moves it off
    // the block's far-left edge and puts it against the number it qualifies.
    //
    // The number track is `min-content`, NOT a fixed 2.5rem. That distinction is
    // the whole fix: a fixed track wider than the digits right-aligns the number
    // inside it and strands the bar at the track's left wall — which is exactly
    // the 40px separation this pass removed, reproduced one column further in.
    // Sized to its content, the track ends where the digits end, so the 4px
    // `gap-x-1` is the real distance between the bar and the number.
    //
    // The digits still form one right edge: every line in a fence has the same
    // digit count in practice, and `tabular-nums` holds the advance when it does
    // not, so the grid resolves one width for the whole block rather than per
    // row.
    <span
      className={`grid grid-cols-[2px_min-content_1ch_1fr] items-baseline gap-x-1 whitespace-pre ${
        anchored ? "bg-hover" : tint.row
      }`}
      data-gutter-line={number}
      data-mark={mark}
      // `CodeFence.Gutter`: a numbered line is a PART of a fence and never
      // appears outside one, so its address says which fence it belongs to.
      data-ui={UI_NAMES.CodeFenceGutter}
    >
      {/* `self-stretch` so the bar is the height of its line rather than of its
          own baseline box: a marker that only spans the glyph reads as a piece
          of punctuation, and one that spans the row reads as a margin mark. */}
      <span aria-hidden className={`self-stretch rounded-sm ${tint.bar}`} data-mark-bar={mark} />
      {onAnchor === undefined ? (
        <span aria-hidden className={numberClass}>
          {number}
        </span>
      ) : (
        <button
          aria-label={`line ${number}`}
          aria-pressed={anchored}
          className={`focus-ring cursor-default rounded-sm transition-quiet hover:text-fg-muted ${numberClass}`}
          onClick={() => onAnchor(number)}
          type="button"
        >
          {number}
        </button>
      )}
      {/* The literal sign, in the same hue as the bar: hidden from assistive
          tech (the row's own content carries it) but present in the DOM so a
          copy of the block reproduces a real diff. The character is what makes
          the diff readable without color at all — the hue is the supplement. */}
      <span aria-hidden className={`select-text font-mono ${tint.sign}`} data-mark-char={mark}>
        {MARK[mark]}
      </span>
      {/* The code text keeps the ACHROMATIC syntax ramp. Tinting it would make
          the fence the loudest region on a text-first surface and would put the
          meaning back in the one channel a colorblind reader cannot use. */}
      <span className="min-w-0">{children}</span>
    </span>
  );
}
