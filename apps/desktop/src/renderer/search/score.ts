/**
 * The sidebar filter's scorer.
 *
 * Pure TypeScript: no React, no I/O, no clock — the same contract the attention
 * engine holds, for the same reason. A ranking that cannot be replayed cannot
 * be trusted, and a filter is a ranking with a visibility cutoff.
 *
 * Case-insensitive SUBSEQUENCE matching, not substring: an operator typing
 * `lap` finds `ledger append path` because they are recalling the shape of a
 * name, not its spelling. The score exists to order matches inside one
 * attention class — never to reorder across classes, which is the attention
 * engine's decision and not this module's.
 */

/**
 * The three qualities of a match, best first. They are ordinal, not additive:
 * a prefix match is categorically better evidence than a scattered one, so the
 * tiers are separated by a gap no per-glyph bonus can close.
 */
const TIER = {
  /** The query is the start of the field. `led` → `ledger append path`. */
  prefix: 3000,
  /** Every query glyph lands on a word start. `lap` → `ledger append path`. */
  wordStart: 2000,
  /** The glyphs appear in order, anywhere. `lgp` → `ledger append path`. */
  subsequence: 1000,
} as const;

/** Where a matched glyph landed, so the view can weight exactly those. */
export type MatchSpan = readonly number[];

export interface Match {
  readonly score: number;
  /** Indices into the ORIGINAL text, ascending. Empty for an empty query. */
  readonly spans: MatchSpan;
}

/**
 * Score one field against one query.
 *
 * `null` means "no match", which is a different fact from "matched with score
 * zero" — the filter uses the distinction to decide visibility, so the two are
 * not collapsed into a sentinel number.
 */
export function scoreText(text: string, query: string): Match | null {
  if (query.length === 0) return { score: 0, spans: [] };

  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  // Two walks, because "leftmost" and "best" are different answers. A greedy
  // leftmost walk of `lap` over `ledger append path` lands the `p` inside
  // `append` and reports a scattered match, when the one the operator meant is
  // the three word starts. So the word-start walk is tried first and the
  // leftmost walk is the fallback.
  const aligned = subsequence(haystack, needle, true);
  const spans = aligned ?? subsequence(haystack, needle, false);
  if (spans === null) return null;

  return { score: TIER[tierOf(haystack, needle, spans)] + compactness(spans), spans };
}

/**
 * Greedy subsequence walk, left to right.
 *
 * With `preferWordStart`, each glyph takes the next occurrence that begins a
 * word and the walk fails if any glyph has none — so it either produces a fully
 * word-aligned match or nothing, and never a half-aligned one that would score
 * as scattered anyway. Without it, each glyph takes the next occurrence of any
 * kind: leftmost, because a match the reader sees first is the match they mean.
 */
function subsequence(haystack: string, needle: string, preferWordStart: boolean): MatchSpan | null {
  const spans: number[] = [];
  let cursor = 0;

  for (const glyph of needle) {
    const hit = preferWordStart
      ? nextWordStart(haystack, glyph, cursor)
      : haystack.indexOf(glyph, cursor);
    if (hit === -1) return null;
    spans.push(hit);
    cursor = hit + 1;
  }
  return spans;
}

/** The next occurrence of `glyph` at or after `from` that begins a word. */
function nextWordStart(haystack: string, glyph: string, from: number): number {
  for (let at = haystack.indexOf(glyph, from); at !== -1; at = haystack.indexOf(glyph, at + 1)) {
    if (isWordStart(haystack, at)) return at;
  }
  return -1;
}

type Tier = keyof typeof TIER;

function tierOf(haystack: string, needle: string, spans: MatchSpan): Tier {
  if (haystack.startsWith(needle)) return "prefix";
  if (spans.every((index) => isWordStart(haystack, index))) return "wordStart";
  return "subsequence";
}

/**
 * A word start is index 0 or anything following a separator. Separators are the
 * ones session and project names actually use — spaces, hyphens, dots, slashes,
 * underscores — so `atlas-migration` splits at the hyphen the way it reads.
 */
const SEPARATORS = new Set([" ", "-", "_", ".", "/", ":"]);

function isWordStart(haystack: string, index: number): boolean {
  if (index === 0) return true;
  const previous = haystack[index - 1];
  return previous !== undefined && SEPARATORS.has(previous);
}

/**
 * Within a tier, a tighter match wins: `run` on `runner` beats `run` scattered
 * across `r…u…n`. Bounded strictly below 1000 so it can only ever break a tie
 * INSIDE a tier — the tier gap is the load-bearing decision.
 */
function compactness(spans: MatchSpan): number {
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (first === undefined || last === undefined) return 0;

  const spread = last - first + 1;
  // Ideal spread is the query length itself (contiguous). Reward closeness to
  // it, and reward starting early, with the position term weaker than density.
  const density = spans.length / spread;
  const earliness = 1 / (1 + first);
  return Math.round(density * 800 + earliness * 100);
}

/**
 * Score a row across all of its searchable fields and keep the best one.
 *
 * `fields` is ordered by how much the operator is likely to have been recalling
 * — a session's own name first, then its project, then the engine's reason —
 * and ties are broken toward the earlier field, so `kernel` typed at a session
 * named `kernel` does not rank behind one merely belonging to that project.
 */
export interface FieldMatch {
  readonly field: number;
  readonly match: Match;
}

export function scoreFields(fields: readonly string[], query: string): FieldMatch | null {
  let best: FieldMatch | null = null;

  for (const [field, text] of fields.entries()) {
    const match = scoreText(text, query);
    if (match === null) continue;
    if (best === null || match.score > best.match.score) best = { field, match };
  }
  return best;
}
