import { Button as BaseButton } from "@base-ui/react/button";
import type { ReactNode } from "react";
import { UI_NAMES } from "../names";

/**
 * DESIGN.md 7 — Row. The selectable list row, and the only selectable surface
 * in the system.
 *
 * Selection is a raised surface, bold text, and a hairline EDGE. No accent bar
 * and no marker glyph: a raised rectangle carrying the only bold text in the
 * column is already the loudest thing there, and a marker would be decoration
 * repeating what weight already said.
 *
 * The hairline is not decoration and not a card border — it is what makes the
 * fill legible. This system's surface tones are deliberately quiet (`raised` is
 * 1.21:1 from `bg` in dark), and a quiet fill with no edge does not read as a
 * rectangle at all: it reads as a smudge that fades into the column, softest
 * exactly at the corners where the eye looks for an object's boundary. One
 * pixel of `line-surface` gives the fill a definite edge WITHOUT raising the
 * fill toward the grey-box brightness this system rejects — the row stays as
 * quiet as it was and simply becomes a defined shape.
 *
 * Hover gets the same treatment for the same reason, one tone quieter. An
 * unselected row answers hover; a selected row does not, because it already
 * occupies that surface.
 *
 * A row is `one` line on the fixed rhythm step, or `two` when it carries a
 * supporting line beneath its name. The primitive owns both layouts rather than
 * letting a consumer override `h-row`: a row's height is a rhythm decision, and
 * a consumer that fights it produces a clipped second line instead of an error.
 *
 * It also sets the `label` type level as its BASELINE, because a row's default
 * content is its own name. Without it, a row given bare text — or a child that
 * declares a tone but no size — renders at the document's 16px default: two
 * steps above the surface it sits in, and outside the density scope entirely.
 * A child that wants another level still says so and wins on specificity.
 */
export type RowLines = "one" | "two";

/**
 * Depth in the navigator's PROJECT → SESSION → SETTLED hierarchy. It is a
 * MARGIN, not padding: the indent sits OUTSIDE the row's own surface, so a
 * hovered or selected row's fill starts at that row's indent instead of at the
 * column's edge. A fill that spans the full column paints every level the same
 * width and flattens the tree exactly where the highlight is loudest — the
 * highlight itself has to report depth.
 */
export type RowLevel = 0 | 1 | 2;

/**
 * `margin-left` per level, paired with the matching width reduction so the row
 * still ends on the column's right edge: `w-full` plus a left margin would push
 * the row's right edge out past the sidebar and clip its own text.
 */
const LEVEL: Record<RowLevel, string> = {
  0: "w-full",
  1: "ml-indent w-[calc(100%-var(--spacing-indent))]",
  2: "ml-[calc(var(--spacing-indent)*2)] w-[calc(100%-var(--spacing-indent)*2)]",
};

/**
 * `two` sets its own vertical inset rather than a height, because its content
 * decides the height. The inset is 8px — the same baseline step as everything
 * else in the column, so a two-line row stacks against a one-line row without
 * breaking the grid.
 */
const LINES: Record<RowLines, string> = {
  one: "h-row items-center gap-2 overflow-hidden",
  two: "flex-col items-start gap-0 py-inset",
};

export function Row({
  current = false,
  lines = "one",
  level = 0,
  chevronSlot = false,
  className = "",
  children,
  ...rest
}: {
  /** This row is the one currently open in the main column. */
  readonly current?: boolean;
  readonly lines?: RowLines;
  /** Depth in the tree. Indents the row and narrows its own fill. */
  readonly level?: RowLevel;
  /**
   * Reserve the chevron column even though a row carries no chevron, so a row
   * and a `Disclosure` header at the same level share one text x. It is left
   * PADDING rather than a spacer child: a two-line row is a flex column, and a
   * spacer there would stack above the name instead of beside it.
   */
  readonly chevronSlot?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
} & Omit<BaseButton.Props, "className" | "children" | "render" | "style">) {
  /* `border` is declared unconditionally and only its COLOR changes, so a row
     never gains or loses a 1px box as it is hovered. A border that appears on
     hover shifts the row's content by a pixel and the whole column twitches;
     `transparent` holds the space and the transition animates colour alone. */
  const surface = current
    ? "border-line-surface bg-raised font-medium text-fg"
    : "border-transparent text-fg-muted hover:border-line-surface hover:bg-hover hover:text-fg";

  return (
    <BaseButton
      aria-current={current ? "true" : undefined}
      className={`focus-ring group/row flex select-none rounded-md border px-row-inset text-left text-label transition-quiet active:bg-active disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 ${LINES[lines]} ${LEVEL[level]} ${
        chevronSlot ? "ps-[calc(var(--spacing-row-inset)+var(--spacing-indent-slot))]" : ""
      } ${surface} ${className}`}
      data-level={level}
      data-ui={UI_NAMES.Row}
      {...rest}
    >
      {children}
    </BaseButton>
  );
}
