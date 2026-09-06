import type { RunState, SessionId } from "../mock/console";

/** Milliseconds since the Unix epoch. Injected, never read from the clock. */
export type EpochMs = number;

/**
 * The attention classes, in rank order. A session's class dominates its score:
 * a waiting session outranks every running one no matter how fresh the running
 * one is, because "needs you" and "is fine" are not comparable quantities.
 *
 * Lower rank sorts first.
 */
export const CLASS_RANK = {
  pinned: 0,
  waiting: 1,
  interrupted: 2,
  finished: 3,
  running: 4,
  settled: 5,
} as const;

export type AttentionClass = keyof typeof CLASS_RANK;

/** The runtime signals the engine reads. None of them live on a session. */
export interface Signals {
  readonly now: EpochMs;
  /** What the Owner is looking at right now. */
  readonly activeSessionId: SessionId | null;
  /** Explicit user override — always top of its project. */
  readonly pins: ReadonlySet<SessionId>;
  /** Demoted to the settled tail until this instant. */
  readonly snoozes: ReadonlyMap<SessionId, EpochMs>;
  readonly lastReadAt: ReadonlyMap<SessionId, EpochMs>;
  /** Typing or mid-scroll. A weak cue: it holds order, it never reorders. */
  readonly userBusy: boolean;
}

/** The session facts the engine scores. Deliberately not the whole Session. */
export interface SessionFacts {
  readonly id: SessionId;
  readonly state: RunState;
  readonly lastEventAt: EpochMs;
  /** When the Owner last spoke. Unanswered turns leave attention residue. */
  readonly lastUserTurnAt: EpochMs;
  readonly unreadCount: number;
}

const HOUR = 3_600_000;
const RECENCY_HALFLIFE = 6 * HOUR;
const RESIDUE_HALFLIFE = 24 * HOUR;
const RESIDUE_WEIGHT = 0.5;

/**
 * Classifies one session. Order of the checks IS the precedence, and each
 * branch is a claim about the Owner's attention rather than about the data:
 *
 *  - a pin is an override, so it is checked before any signal can argue;
 *  - a snooze is the Owner saying "not now", so it demotes past every class
 *    except the tail it demotes into;
 *  - `done` splits on unread: a result the Owner has not seen is news, and a
 *    result they have seen is history.
 */
export function classify(facts: SessionFacts, signals: Signals): AttentionClass {
  if (signals.pins.has(facts.id)) return "pinned";

  const snoozedUntil = signals.snoozes.get(facts.id);
  if (snoozedUntil !== undefined && snoozedUntil > signals.now) return "settled";

  switch (facts.state) {
    case "waiting":
      return "waiting";
    case "interrupted":
      return "interrupted";
    case "running":
      return "running";
    case "done":
      return facts.unreadCount > 0 ? "finished" : "settled";
    default:
      return unreachable(facts.state);
  }
}

/**
 * Within a class, freshness plus residue. Both decay exponentially, so a
 * session never stops being ranked — it only stops being loud.
 *
 * The residue term (R03) fires only when the Owner's own last turn is the most
 * recent thing that happened: an unanswered question is a thread the Owner is
 * still holding open, and it should not sink under sessions that are merely
 * newer. Once the agent responds, `lastEventAt` moves past `lastUserTurnAt` and
 * the bump disappears on its own.
 */
export function score(facts: SessionFacts, now: EpochMs): number {
  const recency = decay(now - facts.lastEventAt, RECENCY_HALFLIFE);
  const unanswered = facts.lastUserTurnAt >= facts.lastEventAt;
  const residue = unanswered
    ? RESIDUE_WEIGHT * decay(now - facts.lastUserTurnAt, RESIDUE_HALFLIFE)
    : 0;
  return recency + residue;
}

/** `exp(-age / halflife)`, clamped so a future timestamp cannot exceed 1. */
function decay(ageMs: number, halflifeMs: number): number {
  return Math.exp(-Math.max(0, ageMs) / halflifeMs);
}

function unreachable(value: never): never {
  throw new Error(`unclassifiable run state: ${JSON.stringify(value)}`);
}
