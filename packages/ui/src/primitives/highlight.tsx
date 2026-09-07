import { UI_NAMES } from "../names";
import type { TextTone } from "./surface";

/**
 * Highlight. Match emphasis inside a label, as WEIGHT ONLY.
 *
 * Matched glyphs take the primary tone at medium weight; the rest of the label
 * stays on the tone it would have had anyway. There is no color and no
 * background, for two reasons that are both about the accent budget: the
 * system's one chroma is spent on live state and the primary action, and a
 * highlight FILL would put a second small box inside a row whose whole
 * hierarchy is quiet type on quiet whitespace. Weight is already the mechanism
 * for selection, so a matched run reads as emphasis rather than as a new kind
 * of object.
 *
 * Both run kinds state their weight OUTRIGHT rather than letting the unmatched
 * remainder inherit. The selected row is already set in medium weight, so an
 * unmatched run that inherits would render at the same weight as a matched one
 * and the highlight would silently say nothing on exactly the row the operator
 * is on — the one place a wrong answer is most expensive.
 *
 * The primitive is data-blind: it takes pre-split runs and knows nothing about
 * queries, scoring, or what is being matched. Splitting is the caller's job.
 *
 * It sets its own type LEVEL (`label`) rather than inheriting. A run of bare
 * spans inherits the document's 16px default, so this primitive rendered a
 * session name two steps above the row it sits in and ignored the density
 * scope entirely — the name is a row's own label, and `Text`'s `label` level is
 * what that means in this system. Pinned by packages/ui/test/primitives.test.tsx.
 */
export interface HighlightRun {
  readonly text: string;
  readonly matched: boolean;
}

const REST: Record<TextTone, string> = {
  fg: "text-fg",
  muted: "text-fg-muted",
  subtle: "text-fg-subtle",
  faint: "text-fg-faint",
  accent: "text-accent",
};

export function Highlight({
  runs,
  tone = "muted",
  className = "",
}: {
  readonly runs: readonly HighlightRun[];
  /** The tone of the UNMATCHED remainder. Matched glyphs are always primary. */
  readonly tone?: TextTone;
  readonly className?: string;
}) {
  return (
    <span
      className={`min-w-0 truncate text-label ${REST[tone]} ${className}`}
      data-ui={UI_NAMES.Highlight}
    >
      {runs.map((run, index) => (
        // Runs are positional by construction — order IS the identity here, and
        // a content-derived key would collide on a repeated glyph.
        <span
          className={run.matched ? "font-medium text-fg" : "font-normal"}
          // biome-ignore lint/suspicious/noArrayIndexKey: run order is the identity
          key={index}
        >
          {run.text}
        </span>
      ))}
    </span>
  );
}
