import type { ReactNode } from "react";
import { UI_NAMES } from "../names";
import { Text } from "./surface";

export type CodeTone = "plain" | "keyword" | "string" | "number" | "comment" | "fn" | "punct";

/**
 * DESIGN.md 7 — CodeToken. Syntax color is the achromatic ramp: the accent is
 * reserved for live state, so a code fence has no chroma to spend and reads by
 * weight and tone alone. This is what stops a fence from becoming the loudest
 * region on a text-first surface.
 */
const TONE: Record<CodeTone, string> = {
  plain: "text-fg-muted",
  keyword: "text-fg font-medium",
  string: "text-fg-subtle",
  number: "text-fg-subtle",
  comment: "text-fg-faint",
  fn: "text-fg",
  punct: "text-fg-faint",
};

export function CodeToken({
  tone,
  children,
}: {
  readonly tone: CodeTone;
  readonly children: ReactNode;
}) {
  return (
    <span className={TONE[tone]} data-ui={UI_NAMES.CodeToken}>
      {children}
    </span>
  );
}

/**
 * A code block: one quiet tonal step off the column, bounded by a hairline.
 *
 * The fill and the edge were chosen TOGETHER, and the pairing is the point.
 * Previously the fence had no border, which meant its fill was the only thing
 * defining it — and a fill strong enough to define a region unaided is a grey
 * box, the exact frame this system replaced with tone. Adding one pixel of
 * `line-surface` lets the fill drop to `sunken`, the LIGHTEST step off the
 * column (1.06:1 dark, 1.04:1 light): barely a tint, yet unmistakably a region,
 * because the edge now does the defining the fill used to strain at. The result
 * is quieter than the old fence and reads more clearly — which is the whole
 * trade a hairline buys.
 *
 * 6px radius — the shared surface scale, not a bespoke corner. A fence is a
 * bigger rectangle than a row, but it is the same KIND of thing: a bounded
 * region on the column. Giving it its own radius would mean the system had two
 * answers to "how round is a surface here", and the second answer would be
 * legible as inconsistency long before it read as hierarchy.
 *
 * The language label is the only chrome, and it is mono because it is machine
 * truth about the block rather than a decoration on it.
 */
export function CodeFence({
  lang,
  children,
}: {
  readonly lang: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-line-surface bg-sunken px-gutter py-inset"
      data-ui={UI_NAMES.CodeFence}
    >
      <Text level="micro" mono tone="faint">
        {lang}
      </Text>
      {/* The CODE VOICE, 13/20, set here on the container rather than per token.
          This is the one place in the transcript a size lands on a block instead
          of on a run of text, and it is deliberate: a fence is uniform material,
          and per-token sizes inside it would ripple as the syntax changed.

          It is a literal pair rather than `text-meta` for the same reason the
          other two voices are — the fence must not re-point when a density scope
          changes, or code silently becomes a fourth size. */}
      <pre className="overflow-x-auto whitespace-pre font-mono text-[13px]/[20px]">
        <code>{children}</code>
      </pre>
    </div>
  );
}
