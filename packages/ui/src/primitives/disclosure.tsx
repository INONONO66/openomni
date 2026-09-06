import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";
import type { ReactNode } from "react";
import { UI_NAMES } from "../names";
import type { RowLevel } from "./row";

/**
 * DESIGN.md 7 — Disclosure. A group header that expands a region: the sidebar's
 * project groups and the timeline's collapsed detail.
 *
 * The header is overline text with no surface of its own at rest — a group
 * label is a container, not a selectable item, so it must not be mistakable for
 * a row beneath it. The chevron is the one rotating element in the system, and
 * it rotates because it reports state.
 *
 * It ROTATES rather than swapping between a right-pointing and a down-pointing
 * mark. A swap is a cut: the old shape vanishes and a new one appears, so there
 * is nothing to follow and the state change has to be re-read. A rotation is
 * continuous — the same mark turns, and the turn itself is the message. It is
 * also why the chevron is the system's one moving part: disclosure is the only
 * place where a single element genuinely has two states to travel between.
 *
 * Drawn inline rather than pulled from an icon set. At 12px an icon library's
 * 24-unit chevron scales its stroke down with it — a nominal 2px lands at 1px
 * on screen — so the mark came out thinner than every hairline beside it and
 * looked broken rather than quiet. Drawing it on a 12-unit grid means 1.5px is
 * 1.5px: heavier than the 1px structural strokes, which is correct, because a
 * chevron is a CONTROL and the connectors are structure.
 *
 * The panel opens ONE rhythm step below the header (`--spacing-group-gap`),
 * looser than the gap between rows. A label sitting on the same step as its
 * first row makes the two read as siblings, and the whole point of the header
 * is that it is not one — grouping is whitespace here, because it cannot be a
 * box and cannot be a line.
 *
 * `level` is the header's depth in the tree, and like `Row` it is a MARGIN: the
 * header's own hover fill starts at its indent, so the highlight reports depth
 * instead of erasing it. The chevron sits in a fixed slot that is reserved at
 * every level whether a chevron lands in it or not, so a header and a row at
 * one level share a single text x.
 *
 * Base UI owns `aria-expanded`, `aria-controls`, and panel unmounting, so a
 * collapsed group is absent from the accessibility tree rather than hidden.
 */

/**
 * How loud the group label is. `subtle` is a project — the tree's root. `faint`
 * is a group NESTED inside one (the settled tail), one tone quieter so the two
 * caps labels do not read as peers of each other.
 */
export type DisclosureTone = "subtle" | "faint";

const TONE: Record<DisclosureTone, string> = {
  subtle: "text-fg-subtle",
  faint: "text-fg-faint",
};

/** Mirrors `Row`'s level geometry exactly, or the two stop sharing a text x. */
const LEVEL: Record<RowLevel, string> = {
  0: "w-full",
  1: "ml-indent w-[calc(100%-var(--spacing-indent))]",
  2: "ml-[calc(var(--spacing-indent)*2)] w-[calc(100%-var(--spacing-indent)*2)]",
};

export function Disclosure({
  label,
  trailing,
  collapsedCount,
  level = 0,
  tone = "subtle",
  defaultOpen = true,
  className = "",
  children,
}: {
  readonly label: string;
  /** Right-aligned header metadata, e.g. a count. */
  readonly trailing?: ReactNode;
  /**
   * How many rows the closed group is hiding, printed beside the label while
   * it is closed and dropped once it opens — an open group's rows ARE the
   * count, so keeping it would be the same fact twice. Hidden by CSS from the
   * trigger's own `data-panel-open`, so the group stays uncontrolled: a count
   * is not worth lifting open state into every consumer.
   */
  readonly collapsedCount?: number;
  /** Depth in the tree. Indents the header and narrows its own fill. */
  readonly level?: RowLevel;
  readonly tone?: DisclosureTone;
  readonly defaultOpen?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    // The name rides the ROOT rather than the trigger: the Owner's word covers
    // the header and the region it opens, because "the Disclosure is too tight"
    // is as often about the panel's gap as about the label.
    <BaseCollapsible.Root
      className={className}
      data-ui={UI_NAMES.Disclosure}
      defaultOpen={defaultOpen}
    >
      <BaseCollapsible.Trigger
        className={`focus-ring group flex h-row select-none items-center rounded-md px-row-inset text-left transition-quiet hover:bg-hover ${LEVEL[level]}`}
        data-level={level}
      >
        {/* The slot is a fixed width, not a gap: a 12px glyph in a 16px column
            puts the label at the same x whether the chevron is there or not. */}
        <span aria-hidden className="flex w-indent-slot shrink-0 items-center">
          {/* Round caps and a round join: at 1.5px a mitred chevron ends in two
              hard points that catch the eye harder than the label does. The
              rotation origin is the box centre, so the mark turns in place
              instead of orbiting and shifting the label's x. */}
          {/* biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden decoration; Base UI announces the state via aria-expanded */}
          <svg
            aria-hidden
            className="size-3 text-fg-faint transition-quiet group-data-[panel-open]:rotate-90"
            fill="none"
            height="12"
            viewBox="0 0 12 12"
            width="12"
          >
            <path
              d="M4.5 2.5 L8 6 L4.5 9.5"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.5"
            />
          </svg>
        </span>
        <span
          className={`min-w-0 flex-1 truncate font-semibold text-overline uppercase ${TONE[tone]}`}
        >
          {label}
        </span>
        {collapsedCount !== undefined && (
          <span className="ms-1.5 shrink-0 text-fg-faint text-micro tabular-nums group-data-[panel-open]:hidden">
            · {collapsedCount}
          </span>
        )}
        {trailing}
      </BaseCollapsible.Trigger>
      <BaseCollapsible.Panel className="pt-group-gap">{children}</BaseCollapsible.Panel>
    </BaseCollapsible.Root>
  );
}
