/** Static mock data for the desktop console shell. No IPC, no runtime state. */

export type RunState = "running" | "waiting" | "done" | "interrupted";

export type ProjectId = string;
export type SessionId = string;

/** A workspace grouping. Projects own sessions; they carry no ordering. */
export interface Project {
  readonly id: ProjectId;
  readonly name: string;
}

/**
 * One conversation with one agent, inside one project.
 *
 * `projectId` is membership, not position, and there is no rank, index, or pin
 * flag anywhere on this type. Sequence is decided entirely by
 * `renderer/attention` from run state and timestamps — so a session cannot be
 * moved up the sidebar by editing the data, only by actually needing attention.
 */
export interface Session {
  readonly id: SessionId;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly agent: string;
  readonly state: RunState;
  readonly intent: string;
  /** Last activity of any kind, in epoch ms. */
  readonly lastEventAt: number;
  /** When the Owner last spoke. Feeds the attention-residue term. */
  readonly lastUserTurnAt: number;
  readonly unreadCount: number;
}

/** The mock's fixed reference instant, so every relative age is reproducible. */
export const now = Date.parse("2026-09-03T11:45:00.000Z");

const MINUTE = 60_000;
const HOUR = 3_600_000;
const ago = (ms: number) => now - ms;

/** Declared alphabetically — display order is the attention engine's job. */
export const projects: readonly Project[] = [
  { id: "atlas", name: "atlas-migration" },
  { id: "kernel", name: "openomni-kernel" },
  { id: "perimeter", name: "channel-perimeter" },
];

/**
 * Declared grouped-by-project and otherwise arbitrary. The sidebar shows a
 * different sequence, because sequence is the engine's output — and the fixture
 * is deliberately declared out of attention order to keep that honest.
 */
export const sessions: readonly Session[] = [
  {
    id: "kernel-ledger",
    projectId: "kernel",
    name: "ledger append path",
    agent: "claude-sonnet-4-6",
    state: "running",
    intent: "hoist the lease acquisition above the retry loop",
    lastEventAt: ago(2 * MINUTE),
    lastUserTurnAt: ago(18 * MINUTE),
    unreadCount: 0,
  },
  {
    id: "kernel-alarm",
    projectId: "kernel",
    name: "alarm snapshots",
    agent: "gpt-5-codex",
    state: "interrupted",
    intent: "backfill the snapshot table after the fence change",
    lastEventAt: ago(3 * HOUR),
    lastUserTurnAt: ago(4 * HOUR),
    unreadCount: 1,
  },
  {
    id: "kernel-lease",
    projectId: "kernel",
    name: "lease semantics",
    agent: "claude-sonnet-4-6",
    state: "done",
    intent: "문서에서 리스 계약 조건을 확인하고 정리한다",
    lastEventAt: ago(26 * HOUR),
    lastUserTurnAt: ago(27 * HOUR),
    unreadCount: 0,
  },
  {
    id: "perimeter-router",
    projectId: "perimeter",
    name: "gateway router",
    agent: "claude-sonnet-4-6",
    state: "waiting",
    intent: "admission needs an owner decision on the slack route",
    lastEventAt: ago(9 * MINUTE),
    lastUserTurnAt: ago(40 * MINUTE),
    unreadCount: 1,
  },
  {
    id: "perimeter-slack",
    projectId: "perimeter",
    name: "slack driver",
    agent: "gpt-5-codex",
    state: "running",
    intent: "retry delivery on a 429 without duplicating the wait",
    lastEventAt: ago(30 * MINUTE),
    lastUserTurnAt: ago(90 * MINUTE),
    unreadCount: 0,
  },
  {
    id: "atlas-schema",
    projectId: "atlas",
    name: "schema drift",
    agent: "gpt-5-codex",
    state: "done",
    intent: "reconcile the v3 column rename against the ledger",
    lastEventAt: ago(20 * HOUR),
    lastUserTurnAt: ago(21 * HOUR),
    unreadCount: 0,
  },
  {
    id: "atlas-cutover",
    projectId: "atlas",
    name: "cutover rehearsal",
    agent: "claude-sonnet-4-6",
    state: "done",
    intent: "dry-run the cutover and hold before the destructive step",
    lastEventAt: ago(50 * MINUTE),
    lastUserTurnAt: ago(3 * HOUR),
    unreadCount: 2,
  },
];

export const selectedSessionId: SessionId = "kernel-ledger";

/**
 * The view-state signals the engine reads. In the real console these come from
 * the Owner's interaction; here they are a fixture, and every one of them is a
 * runtime signal rather than a field on a session — which is what keeps ranking
 * out of the data.
 */
export const pins: ReadonlySet<SessionId> = new Set(["kernel-ledger"]);
export const snoozes: ReadonlyMap<SessionId, number> = new Map([["atlas-schema", now + 2 * HOUR]]);
export const lastReadAt: ReadonlyMap<SessionId, number> = new Map([
  ["kernel-ledger", ago(2 * MINUTE)],
  ["kernel-lease", ago(25 * HOUR)],
]);
