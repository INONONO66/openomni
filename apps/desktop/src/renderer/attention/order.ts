import type { ProjectId, SessionId } from "../mock/console";
import { reasonFor } from "./reason";
import { CLASS_RANK, classify, score } from "./score";
import type { AttentionClass, SessionFacts, Signals } from "./score";

/**
 * One live row: a session the Owner may need, and why.
 *
 * Reachable through `Ordered` rather than exported by name — consumers destructure
 * the tree, they never construct a row.
 */
interface OrderedSession {
  readonly id: SessionId;
  readonly reason: string;
}

/** One project group: live rows in attention order, then the settled tail. */
interface OrderedProject {
  readonly id: ProjectId;
  readonly live: readonly OrderedSession[];
  readonly settled: readonly SessionId[];
}

/** The engine's whole output: PROJECT → SESSION, ranked. */
export interface Ordered {
  readonly projects: readonly OrderedProject[];
}

/** A session's facts plus the group it belongs to. */
export type ProjectSessionFacts = SessionFacts & { readonly projectId: ProjectId };

interface Ranked {
  readonly facts: SessionFacts;
  readonly attentionClass: AttentionClass;
  readonly rank: number;
  readonly score: number;
  readonly reason: string;
}

/**
 * The ideal order, right now.
 *
 * Pure and total: same inputs, same output, no clock and no I/O. `now` is a
 * parameter because a ranking that reads the clock cannot be tested and cannot
 * be held steady across a render — and holding it steady is the whole point of
 * the stability rule that wraps this function.
 *
 * `projectIds` fixes which groups exist; it does not fix their sequence. Group
 * order is derived from the sessions inside, so a project rises because its
 * work needs attention, never because of where it was declared.
 */
export function orderByAttention(
  projectIds: readonly ProjectId[],
  facts: readonly ProjectSessionFacts[],
  signals: Signals,
): Ordered {
  const byProject = new Map<ProjectId, Ranked[]>(projectIds.map((id) => [id, []]));

  for (const item of facts) {
    const bucket = byProject.get(item.projectId);
    // A session naming a project that does not exist is an input bug, not a
    // render decision: drop it rather than invent a group to hold it.
    if (!bucket) continue;
    const attentionClass = classify(item, signals);
    bucket.push({
      facts: item,
      attentionClass,
      rank: CLASS_RANK[attentionClass],
      score: score(item, signals.now),
      reason: reasonFor(attentionClass, item, signals),
    });
  }

  const projects: OrderedProject[] = [];
  for (const id of projectIds) {
    const ranked = [...(byProject.get(id) ?? [])].sort(compare);
    projects.push({
      id,
      live: ranked
        .filter((item) => item.attentionClass !== "settled")
        .map(({ facts: session, reason }) => ({ id: session.id, reason })),
      settled: ranked
        .filter((item) => item.attentionClass === "settled")
        .map((item) => item.facts.id),
    });
  }

  return {
    projects: projects.sort((a, b) => projectWeight(byProject, a) - projectWeight(byProject, b)),
  };
}

/**
 * Class first, score second, id last. The id tie-break is not cosmetic: two
 * sessions with identical timestamps must not swap places between renders, and
 * `Array.prototype.sort` stability alone cannot promise that across the
 * regrouping above.
 */
function compare(a: Ranked, b: Ranked): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.score !== b.score) return b.score - a.score;
  return a.facts.id < b.facts.id ? -1 : 1;
}

/**
 * A group weighs as much as its most demanding session. Sorting groups by their
 * best row is what makes the sidebar answer "where do I look" in one glance:
 * the project holding the only waiting session is first, even if it holds
 * nothing else.
 *
 * A project with only settled work sorts last by construction — `settled` is
 * the highest rank, so its best row is also its worst.
 */
function projectWeight(
  byProject: ReadonlyMap<ProjectId, readonly Ranked[]>,
  project: OrderedProject,
): number {
  const ranked = byProject.get(project.id) ?? [];
  if (ranked.length === 0) return Number.POSITIVE_INFINITY;

  let best = Number.POSITIVE_INFINITY;
  for (const item of ranked) {
    // Score refines within a class, so it is folded in as a fraction: a rank
    // step always dominates any score difference.
    const weight = item.rank - Math.min(1, item.score) * 0.5;
    if (weight < best) best = weight;
  }
  return best;
}

/** How many rows moved between two orders — the group header's change hint. */
export function changedSince(previous: Ordered, next: Ordered): number {
  const before = flatten(previous);
  const after = flatten(next);

  let changed = 0;
  for (const [id, position] of after) {
    if (before.get(id) !== position) changed += 1;
  }
  for (const id of before.keys()) {
    if (!after.has(id)) changed += 1;
  }
  return changed;
}

/** Every visible session mapped to its painted position. */
function flatten(ordered: Ordered): ReadonlyMap<SessionId, number> {
  const positions = new Map<SessionId, number>();
  let index = 0;
  for (const project of ordered.projects) {
    for (const session of project.live) positions.set(session.id, index++);
    for (const id of project.settled) positions.set(id, index++);
  }
  return positions;
}
