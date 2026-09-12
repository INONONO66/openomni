import type { ProjectId, Session, SessionId } from "../state/store";

export type AttentionKind = "pinned" | "demand" | "report" | "residue" | "watch" | "rest";
export const ATTENTION_LABEL: Record<AttentionKind, string> = {
  pinned: "Pinned",
  demand: "Requests",
  report: "Reports",
  residue: "Left off",
  watch: "Running",
  rest: "Rest",
};
const KINDS: readonly AttentionKind[] = ["pinned", "demand", "report", "residue", "watch", "rest"];
const HOUR = 3_600_000;

interface OrderedProject {
  readonly id: ProjectId | null;
  readonly sessions: readonly SessionId[];
}
export interface Ordered {
  readonly groups: readonly {
    readonly kind: AttentionKind;
    readonly projects: readonly OrderedProject[];
  }[];
}
type SessionFacts = Pick<
  Session,
  | "id"
  | "projectId"
  | "phase"
  | "createdAt"
  | "lastActivityAt"
  | "phaseSince"
  | "unread"
  | "pinned"
  | "snoozedUntil"
>;

export function attentionKind(session: SessionFacts, now: number): AttentionKind {
  if (session.pinned) return "pinned";
  if (session.snoozedUntil !== null && session.snoozedUntil > now) return "rest";
  switch (session.phase) {
    case "waiting_approval":
    case "waiting_input":
      return "demand";
    case "completed":
    case "failed":
      return session.unread ? "report" : "rest";
    case "interrupted":
      return "residue";
    case "queued":
    case "running":
      return "watch";
    default:
      return "rest";
  }
}

/** Six-hour recency half-life; residue adds a unit bonus with a 24-hour half-life. */
export function attentionScore(session: SessionFacts, now: number): number {
  return scoreForKind(session, now, attentionKind(session, now));
}

function scoreForKind(session: SessionFacts, now: number, kind: AttentionKind): number {
  const age = Math.max(0, now - session.lastActivityAt);
  return (
    2 ** (-age / (6 * HOUR)) +
    (kind === "residue" ? 2 ** (-age / (24 * HOUR)) : 0)
  );
}

/** Rank kinds, then projects by their best row, then rows. No clock or input mutation. */
export function orderByAttention(facts: readonly SessionFacts[], now: number): Ordered {
  const ranked = facts
    .map((session) => {
      const kind = attentionKind(session, now);
      return { session, kind, score: attentionScore(session, now) };
    })
    .sort((a, b) => b.score - a.score || compareId(a.session.id, b.session.id));
  const groups: Ordered["groups"][number][] = [];
  for (const kind of KINDS) {
    const projects = new Map<ProjectId | null, SessionId[]>();
    for (const { session, kind: sessionKind } of ranked) {
      if (sessionKind !== kind) continue;
      const rows = projects.get(session.projectId);
      if (rows) rows.push(session.id);
      else projects.set(session.projectId, [session.id]);
    }
    if (projects.size > 0)
      groups.push({ kind, projects: [...projects].map(([id, sessions]) => ({ id, sessions })) });
  }
  return { groups };
}

function compareId(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

export function changedSince(previous: Ordered, next: Ordered): number {
  const before = flatten(previous);
  const after = flatten(next);
  let changed = 0;
  for (const [id, position] of after) if (before.get(id) !== position) changed += 1;
  for (const id of before.keys()) if (!after.has(id)) changed += 1;
  return changed;
}
function flatten(ordered: Ordered): ReadonlyMap<SessionId, number> {
  const positions = new Map<SessionId, number>();
  for (const group of ordered.groups)
    for (const project of group.projects) {
      for (const id of project.sessions) positions.set(id, positions.size);
    }
  return positions;
}
