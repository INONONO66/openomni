import { z } from "zod";
import { canonicalDigest } from "../json.js";
import { EpochMs } from "../time.js";
import * as Schema from "./schema.js";

export const Event = z
  .object({
    triggerId: z.string().min(1),
    kind: z.enum(Schema.SourceEventKinds),
    text: z.string().min(1).max(Schema.Constants.MAX_EVENT_TEXT_CHARS),
    at: EpochMs,
  })
  .strict();
export type Event = z.infer<typeof Event>;

export const State = z
  .object({
    pending: z.array(Event),
    eventChars: z.number().int().nonnegative().max(Schema.Constants.MAX_COUNTER),
    overflow: z.record(
      z.string(),
      z.number().int().nonnegative().max(Schema.Constants.MAX_COUNTER),
    ),
    lastInjectionAt: z.record(z.string(), EpochMs),
    lastBatchFingerprint: z.record(z.string(), Schema.CanonicalDigest),
    consecutiveWakes: z.number().int().nonnegative().max(Schema.Constants.NOTIFIER_WAKE_BUDGET),
    lastWakeAt: EpochMs.optional(),
    wakeBudgetPaused: z.boolean(),
  })
  .strict();
export type State = z.infer<typeof State>;

export const Effect = z.discriminatedUnion("type", [
  z.object({ type: z.literal("schedule_flush"), dueAt: EpochMs }).strict(),
  z.object({ type: z.literal("schedule_rate_limit"), dueAt: EpochMs }).strict(),
  z
    .object({
      type: z.literal("emit"),
      triggerId: z.string().min(1),
      items: z.array(Schema.SourceItem),
      overflowCount: z.number().int().nonnegative(),
      terminal: z.boolean(),
      firstAt: EpochMs,
      lastAt: EpochMs,
      pauseNotice: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("pause_event_triggers") }).strict(),
]);
export type Effect = z.infer<typeof Effect>;

export interface Result {
  readonly state: State;
  readonly effects: readonly Effect[];
}

export function initialState(): State {
  return {
    pending: [],
    eventChars: 0,
    overflow: {},
    lastInjectionAt: {},
    lastBatchFingerprint: {},
    consecutiveWakes: 0,
    wakeBudgetPaused: false,
  };
}

function itemChars(event: Event): number {
  return event.kind.length + event.text.length + 4;
}

function saturate(value: number): number {
  return Math.min(Schema.Constants.MAX_COUNTER, value);
}

function recalculateChars(events: readonly Event[]): number {
  return events.reduce((sum, event) => sum + itemChars(event), 0);
}

export function observe(candidate: State, rawEvent: Event, now: number): Result {
  const state = State.parse(candidate);
  const event = Event.parse(rawEvent);
  if (event.kind === "line" && state.wakeBudgetPaused) return { state, effects: [] };

  if (event.kind === "summary") {
    const retained = state.pending.filter((pending) => pending.triggerId !== event.triggerId);
    const overflowCount = state.overflow[event.triggerId] ?? 0;
    const overflow = { ...state.overflow };
    delete overflow[event.triggerId];
    const next = State.parse({
      ...state,
      pending: retained,
      eventChars: recalculateChars(retained),
      overflow,
      consecutiveWakes: 0,
      lastWakeAt: now,
      wakeBudgetPaused: false,
      lastInjectionAt: { ...state.lastInjectionAt, [event.triggerId]: now },
    });
    return {
      state: next,
      effects: [
        {
          type: "emit",
          triggerId: event.triggerId,
          items: [{ kind: "summary", text: event.text, at: event.at }],
          overflowCount,
          terminal: true,
          firstAt: event.at,
          lastAt: event.at,
          pauseNotice: false,
        },
      ],
    };
  }

  const capacity = Schema.Constants.NOTIFIER_MAX_CHARS - Schema.Constants.QUEUE_OVERHEAD_CHARS;
  if (
    state.pending.length >= Schema.Constants.NOTIFIER_MAX_LINES ||
    state.eventChars + itemChars(event) > capacity
  ) {
    return {
      state: State.parse({
        ...state,
        overflow: {
          ...state.overflow,
          [event.triggerId]: saturate((state.overflow[event.triggerId] ?? 0) + 1),
        },
      }),
      effects:
        state.pending.length === 0
          ? [{ type: "schedule_flush", dueAt: now + Schema.Constants.NOTIFIER_COALESCE_WINDOW_MS }]
          : [],
    };
  }
  const wasEmpty = state.pending.length === 0;
  const pending = [...state.pending, event];
  return {
    state: State.parse({ ...state, pending, eventChars: recalculateChars(pending) }),
    effects: wasEmpty
      ? [{ type: "schedule_flush", dueAt: now + Schema.Constants.NOTIFIER_COALESCE_WINDOW_MS }]
      : [],
  };
}

interface Group {
  triggerId: string;
  events: Event[];
  overflowCount: number;
}

function grouped(state: State): Group[] {
  const byId = new Map<string, Event[]>();
  for (const event of state.pending) {
    const events = byId.get(event.triggerId) ?? [];
    events.push(event);
    byId.set(event.triggerId, events);
  }
  for (const triggerId of Object.keys(state.overflow)) {
    if (!byId.has(triggerId)) byId.set(triggerId, []);
  }
  return [...byId].map(([triggerId, events]) => ({
    triggerId,
    events,
    overflowCount: state.overflow[triggerId] ?? 0,
  }));
}

function firstAt(group: Group, now: number): number {
  return group.events[0]?.at ?? now;
}

export function flush(candidate: State, now: number): Result {
  let state = State.parse(candidate);
  if (state.pending.length === 0 && Object.keys(state.overflow).length === 0) {
    return { state, effects: [] };
  }
  const effects: Effect[] = [];
  let pending = [...state.pending];
  const overflow = { ...state.overflow };
  const order = grouped(state).sort(
    (left, right) =>
      firstAt(left, now) - firstAt(right, now) || left.triggerId.localeCompare(right.triggerId),
  );
  let earliestRate: number | undefined;

  for (const group of order) {
    if (state.wakeBudgetPaused) break;
    const previousAt = state.lastInjectionAt[group.triggerId];
    const eligibleAt =
      previousAt === undefined ? now : previousAt + Schema.Constants.NOTIFIER_RATE_LIMIT_MS;
    if (now < eligibleAt) {
      earliestRate = Math.min(earliestRate ?? eligibleAt, eligibleAt);
      continue;
    }
    const lines = group.events.map((event) => event.text);
    const fingerprint = canonicalDigest({ triggerId: group.triggerId, lines });
    const duplicate =
      group.overflowCount === 0 && state.lastBatchFingerprint[group.triggerId] === fingerprint;
    pending = pending.filter((event) => event.triggerId !== group.triggerId);
    delete overflow[group.triggerId];
    if (duplicate) continue;

    let streak = state.consecutiveWakes;
    if (
      state.lastWakeAt === undefined ||
      now - state.lastWakeAt >
        Schema.Constants.NOTIFIER_RATE_LIMIT_MS * Schema.Constants.WAKE_STREAK_QUIET_GAP_MULTIPLIER
    ) {
      streak = 0;
    }
    streak += 1;
    const pauseNotice = streak >= Schema.Constants.NOTIFIER_WAKE_BUDGET;
    effects.push({
      type: "emit",
      triggerId: group.triggerId,
      items: group.events.map(({ kind, text, at }) => ({ kind, text, at })),
      overflowCount: group.overflowCount,
      terminal: false,
      firstAt: firstAt(group, now),
      lastAt: group.events[group.events.length - 1]?.at ?? now,
      pauseNotice,
    });
    if (pauseNotice) effects.push({ type: "pause_event_triggers" });
    state = State.parse({
      ...state,
      consecutiveWakes: Math.min(streak, Schema.Constants.NOTIFIER_WAKE_BUDGET),
      lastWakeAt: now,
      wakeBudgetPaused: pauseNotice,
      lastInjectionAt: { ...state.lastInjectionAt, [group.triggerId]: now },
      lastBatchFingerprint: {
        ...state.lastBatchFingerprint,
        [group.triggerId]: fingerprint,
      },
    });
    if (pauseNotice) {
      pending = pending.filter((event) => event.kind === "summary");
      break;
    }
  }

  state = State.parse({
    ...state,
    pending,
    eventChars: recalculateChars(pending),
    overflow,
  });
  if (earliestRate !== undefined && pending.length > 0) {
    effects.push({ type: "schedule_rate_limit", dueAt: earliestRate });
  }
  return { state, effects };
}

export function noteActivity(candidate: State, at: number): Result {
  const state = State.parse(candidate);
  return {
    state: State.parse({
      ...state,
      consecutiveWakes: 0,
      lastWakeAt: at,
      wakeBudgetPaused: false,
    }),
    effects: [],
  };
}

export function rearm(candidate: State, triggerId: string): Result {
  const state = State.parse(candidate);
  const lastInjectionAt = { ...state.lastInjectionAt };
  const lastBatchFingerprint = { ...state.lastBatchFingerprint };
  delete lastInjectionAt[triggerId];
  delete lastBatchFingerprint[triggerId];
  return {
    state: State.parse({
      ...state,
      lastInjectionAt,
      lastBatchFingerprint,
      consecutiveWakes: 0,
      wakeBudgetPaused: false,
    }),
    effects: [],
  };
}

export function dispose(_candidate: State): Result {
  return { state: initialState(), effects: [] };
}
