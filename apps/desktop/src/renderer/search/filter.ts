import type { Ordered } from "../attention";
import type { ProjectId, SessionId } from "../mock/console";
import { type MatchSpan, scoreFields } from "./score";

/**
 * Apply a query to the painted order.
 *
 * Two rules make this more than a `filter` call, and both are attention rules
 * rather than search rules:
 *
 * 1. **The hierarchy survives.** A matching session keeps its project header as
 *    its parent, so a result never appears at an unexplained depth. A project
 *    with no matching session disappears entirely — an empty header is a row
 *    spent saying nothing.
 * 2. **The attention order survives.** Results are painted in exactly the
 *    sequence the attention engine produced. The scorer's number orders matches
 *    only INSIDE a class, and it never moves a row across one: a `waiting`
 *    session does not sink below a `running` one because the query happened to
 *    spell the running one better.
 */

/** What a row's searchable text is made of, in recall-likelihood order. */
export type SearchFields = readonly [session: string, project: string, reason: string];

export interface FilteredSession {
  readonly id: SessionId;
  readonly reason: string;
  /**
   * Glyph indices in the SESSION NAME to weight, or empty when the match landed
   * on the project or the reason instead. Highlighting is weight-only, so a
   * match elsewhere is reported by the row's presence rather than by decorating
   * a field the query did not hit.
   */
  readonly spans: MatchSpan;
}

/** Not exported: callers reach it through `Filtered.projects`, not by name. */
interface FilteredProject {
  readonly id: ProjectId;
  readonly live: readonly FilteredSession[];
  readonly settled: readonly FilteredSession[];
  /**
   * A settled tail auto-opens when it holds a match: a result hidden behind a
   * collapsed disclosure is a result the operator was not shown.
   */
  readonly settledOpen: boolean;
}

export interface Filtered {
  readonly projects: readonly FilteredProject[];
  /** Every visible session id, in painted order — the arrow-key sequence. */
  readonly sequence: readonly SessionId[];
  readonly total: number;
  /** True when no query is applied, so the view can keep the tree untouched. */
  readonly unfiltered: boolean;
}

/**
 * `fieldsFor` is injected rather than read from a session, so this module holds
 * no opinion about what a session is beyond "it has an id and some text".
 */
export function filterOrdered(
  ordered: Ordered,
  query: string,
  fieldsFor: (id: SessionId, reason: string) => SearchFields,
): Filtered {
  const trimmed = query.trim();

  if (trimmed.length === 0) {
    const projects = ordered.projects.map((group) => ({
      id: group.id,
      live: group.live.map((entry) => ({ id: entry.id, reason: entry.reason, spans: EMPTY })),
      settled: group.settled.map((id) => ({ id, reason: "", spans: EMPTY })),
      settledOpen: false,
    }));
    return {
      projects,
      sequence: projects.flatMap((group) => group.live.map((entry) => entry.id)),
      total: projects.reduce((count, group) => count + group.live.length, 0),
      unfiltered: true,
    };
  }

  const projects: FilteredProject[] = [];

  for (const group of ordered.projects) {
    const live = matching(
      group.live.map((entry) => ({ id: entry.id, reason: entry.reason })),
      trimmed,
      fieldsFor,
    );
    const settled = matching(
      group.settled.map((id) => ({ id, reason: "" })),
      trimmed,
      fieldsFor,
    );

    // A header with no matching child is a row spent on nothing.
    if (live.length === 0 && settled.length === 0) continue;

    projects.push({ id: group.id, live, settled, settledOpen: settled.length > 0 });
  }

  const sequence = projects.flatMap((group) => [
    ...group.live.map((entry) => entry.id),
    ...group.settled.map((entry) => entry.id),
  ]);

  return { projects, sequence, total: sequence.length, unfiltered: false };
}

const EMPTY: MatchSpan = [];

/**
 * Keep the rows that match, in the order they arrived.
 *
 * The scorer's number is deliberately NOT used to sort here. It selects which
 * field a row matched on and therefore which glyphs to weight; the sequence
 * belongs to the attention engine. Sorting by score would answer "which name
 * does the query spell best", and the question on screen is "what needs you".
 */
function matching(
  rows: readonly { readonly id: SessionId; readonly reason: string }[],
  query: string,
  fieldsFor: (id: SessionId, reason: string) => SearchFields,
): readonly FilteredSession[] {
  const kept: FilteredSession[] = [];

  for (const row of rows) {
    const fields = fieldsFor(row.id, row.reason);
    const hit = scoreFields(fields, query);
    if (hit === null) continue;

    // Only a hit on field 0 — the session's own name — produces highlight
    // spans, because that is the only string the row prints in full.
    kept.push({
      id: row.id,
      reason: row.reason,
      spans: hit.field === 0 ? hit.match.spans : EMPTY,
    });
  }
  return kept;
}

/**
 * Split a label into weighted and unweighted runs.
 *
 * Highlighting is WEIGHT ONLY — matched glyphs in the primary tone at medium
 * weight, the rest one tone quieter. No color and no background: this system
 * spends its single chroma on live state, and a highlight fill would put a
 * second box in a column whose whole hierarchy is quiet type.
 */
export interface Run {
  readonly text: string;
  readonly matched: boolean;
}

export function highlightRuns(text: string, spans: MatchSpan): readonly Run[] {
  if (spans.length === 0) return [{ text, matched: false }];

  const marked = new Set(spans);
  const runs: Run[] = [];
  // Iterate code points, so a span index that lands inside a surrogate pair or
  // a Hangul syllable cannot split the glyph it is meant to weight.
  const glyphs = [...text];

  for (const [index, glyph] of glyphs.entries()) {
    const matched = marked.has(index);
    const tail = runs[runs.length - 1];
    if (tail !== undefined && tail.matched === matched) {
      runs[runs.length - 1] = { text: tail.text + glyph, matched };
      continue;
    }
    runs.push({ text: glyph, matched });
  }
  return runs;
}
