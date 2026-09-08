import type { Ordered } from "../attention";
import type { AttentionKind } from "../attention/order";
import type { ProjectId, SessionId } from "../state/store";
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
 *    sequence the attention engine produced. The scorer's number decides which
 *    field a row matched on, never where the row sits.
 */

/** What a row's searchable text is made of, in recall-likelihood order. */
export type SearchFields = readonly [session: string, project: string];

export interface FilteredSession {
  readonly id: SessionId;
  /**
   * Glyph indices in the SESSION TITLE to weight, or empty when the match landed
   * on the project instead. Highlighting is weight-only, so a match elsewhere is
   * reported by the row's presence rather than by decorating a field the query
   * did not hit.
   */
  readonly spans: MatchSpan;
}

/** A project's matched rows within one attention kind. */
interface FilteredProject {
  readonly id: ProjectId | null;
  readonly sessions: readonly FilteredSession[];
}

export interface Filtered {
  readonly groups: readonly { readonly kind: AttentionKind; readonly projects: readonly FilteredProject[] }[];
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
  fieldsFor: (id: SessionId) => SearchFields,
): Filtered {
  const trimmed = query.trim();
  const unfiltered = trimmed.length === 0;
  const groups = ordered.groups.map((group) => ({
    kind: group.kind,
    projects: group.projects.map((project) => ({
      id: project.id,
      sessions: unfiltered
        ? project.sessions.map((id) => ({ id, spans: EMPTY }))
        : matching(project.sessions, trimmed, fieldsFor),
    })).filter((project) => project.sessions.length > 0),
  })).filter((group) => group.projects.length > 0);
  const sequence = groups.flatMap((group) => group.projects.flatMap((project) => project.sessions.map((entry) => entry.id)));
  return { groups, sequence, total: sequence.length, unfiltered };
}

const EMPTY: MatchSpan = [];

/**
 * Keep the rows that match, in the order they arrived.
 *
 * The scorer's number is deliberately NOT used to sort here. It selects which
 * field a row matched on and therefore which glyphs to weight; the sequence
 * belongs to the attention engine. Sorting by score would answer "which title
 * does the query spell best", and the question on screen is "what needs you".
 */
function matching(
  rows: readonly SessionId[],
  query: string,
  fieldsFor: (id: SessionId) => SearchFields,
): readonly FilteredSession[] {
  const kept: FilteredSession[] = [];

  for (const id of rows) {
    const hit = scoreFields(fieldsFor(id), query);
    if (hit === null) continue;

    // Only a hit on field 0 — the session's own title — produces highlight
    // spans, because that is the only string the row prints in full.
    kept.push({ id, spans: hit.field === 0 ? hit.match.spans : EMPTY });
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
