import type { ProjectId, SessionId } from "../state/store";

/** One project group: its sessions, ranked. `null` is the unfiled group. */
interface OrderedProject {
  readonly id: ProjectId | null;
  readonly sessions: readonly SessionId[];
}

/** The engine's whole output: PROJECT → SESSION, ranked. */
export interface Ordered {
  readonly projects: readonly OrderedProject[];
}

/**
 * What the engine ranks on. Deliberately not the whole `Session`: a title is
 * not a ranking signal, and keeping it out of the input is what stops one from
 * becoming one.
 *
 * Right now the only fact a session carries is when it was created. Run state,
 * unread counts, and the Owner's own pins were ranking inputs once, but nothing
 * real produced them — they were fixture fields — so they are gone rather than
 * left as a shape the wire does not fill. When the gateway can report a
 * session's state, that state is added HERE and the classes come back with it.
 */
export interface SessionFacts {
  readonly id: SessionId;
  readonly projectId: ProjectId | null;
  readonly createdAt: number;
}

/**
 * The ideal order, right now.
 *
 * Pure and total: same inputs, same output, no clock and no I/O — and holding
 * it steady across a render is the stability rule's job, not this function's.
 *
 * Groups exist because sessions do: a project appears when its first session
 * does and disappears with its last, in the order the sessions themselves earn.
 * A group weighs as much as its newest session, so the project holding the most
 * recent work is first even if it holds nothing else.
 */
export function orderByAttention(facts: readonly SessionFacts[]): Ordered {
  const byProject = new Map<ProjectId | null, SessionFacts[]>();
  for (const item of facts) {
    const bucket = byProject.get(item.projectId);
    if (bucket) bucket.push(item);
    else byProject.set(item.projectId, [item]);
  }

  const projects = [...byProject.entries()].map(([id, bucket]) => {
    const ranked = [...bucket].sort(compare);
    return { id, sessions: ranked.map((item) => item.id), newest: ranked[0]?.createdAt ?? 0 };
  });

  return {
    projects: projects
      .sort((a, b) => b.newest - a.newest || compareId(a.id ?? "", b.id ?? ""))
      .map(({ id, sessions }) => ({ id, sessions })),
  };
}

/**
 * Newest first, id last. The id tie-break is not cosmetic: two sessions created
 * in the same millisecond must not swap places between renders, and
 * `Array.prototype.sort` stability alone cannot promise that across the
 * regrouping above.
 */
function compare(a: SessionFacts, b: SessionFacts): number {
  return b.createdAt - a.createdAt || compareId(a.id, b.id);
}

function compareId(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
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
    for (const id of project.sessions) positions.set(id, index++);
  }
  return positions;
}
