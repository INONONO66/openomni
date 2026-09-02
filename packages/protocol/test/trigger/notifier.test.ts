import { describe, expect, test } from "bun:test";
import { canonicalDigest } from "../../src/json.js";
import { Trigger } from "../../src/trigger/index.js";
import { CREATED_AT } from "../helpers/trigger.js";

const {
  NOTIFIER_COALESCE_WINDOW_MS: WINDOW,
  NOTIFIER_RATE_LIMIT_MS: RATE,
  NOTIFIER_MAX_LINES: MAX_LINES,
  NOTIFIER_MAX_CHARS: MAX_CHARS,
  NOTIFIER_WAKE_BUDGET: WAKE_BUDGET,
  QUEUE_OVERHEAD_CHARS: OVERHEAD,
  WAKE_STREAK_QUIET_GAP_MULTIPLIER: QUIET_GAP,
} = Trigger.Constants;

function line(triggerId: string, text: string, at: number): Trigger.Notifier.Event {
  return { triggerId, kind: "line", text, at };
}

function summary(triggerId: string, text: string, at: number): Trigger.Notifier.Event {
  return { triggerId, kind: "summary", text, at };
}

function emits(effects: readonly Trigger.Notifier.Effect[]) {
  return effects.filter((effect) => effect.type === "emit");
}

function observeAll(
  start: Trigger.Notifier.State,
  events: readonly (readonly [Trigger.Notifier.Event, number])[],
): Trigger.Notifier.State {
  return events.reduce(
    (state, [event, now]) => Trigger.Notifier.observe(state, event, now).state,
    start,
  );
}

describe("Trigger notifier — coalescing window", () => {
  test("the first event schedules one flush and later events do not move it", () => {
    const first = Trigger.Notifier.observe(
      Trigger.Notifier.initialState(),
      line("t1", "one", CREATED_AT),
      CREATED_AT,
    );
    expect(first.effects).toEqual([{ type: "schedule_flush", dueAt: CREATED_AT + WINDOW }]);

    const second = Trigger.Notifier.observe(
      first.state,
      line("t1", "two", CREATED_AT + 1),
      CREATED_AT + 1,
    );
    expect(second.effects).toEqual([]);
    expect(second.state.pending).toHaveLength(2);
  });

  test("a flush with no queued work and no overflow is a no-op", () => {
    const result = Trigger.Notifier.flush(Trigger.Notifier.initialState(), CREATED_AT);
    expect(result.effects).toEqual([]);
    expect(result.state).toEqual(Trigger.Notifier.initialState());
  });

  test("a flush drains queued lines into one emission per trigger", () => {
    const state = observeAll(Trigger.Notifier.initialState(), [
      [line("t1", "a", CREATED_AT), CREATED_AT],
      [line("t1", "b", CREATED_AT + 1), CREATED_AT + 1],
      [line("t2", "c", CREATED_AT + 2), CREATED_AT + 2],
    ]);

    const result = Trigger.Notifier.flush(state, CREATED_AT + WINDOW);
    const emitted = emits(result.effects);
    expect(emitted.map((effect) => effect.triggerId)).toEqual(["t1", "t2"]);
    expect(emitted[0]?.items.map((item) => item.text)).toEqual(["a", "b"]);
    expect(emitted[0]?.terminal).toBe(false);
    expect(result.state.pending).toHaveLength(0);
    expect(result.state.eventChars).toBe(0);
  });

  test("groups are emitted in stable (firstAt, triggerId) order", () => {
    const state = observeAll(Trigger.Notifier.initialState(), [
      [line("t-z", "later trigger, earlier line", CREATED_AT), CREATED_AT],
      [line("t-a", "earlier trigger, later line", CREATED_AT + 5), CREATED_AT + 5],
    ]);
    const emitted = emits(Trigger.Notifier.flush(state, CREATED_AT + WINDOW).effects);
    expect(emitted.map((effect) => effect.triggerId)).toEqual(["t-z", "t-a"]);
  });
});

describe("Trigger notifier — queue bounds and overflow", () => {
  test("admission past the line cap counts overflow instead of growing the queue", () => {
    let state = Trigger.Notifier.initialState();
    for (let index = 0; index < MAX_LINES; index += 1) {
      state = Trigger.Notifier.observe(
        state,
        line("t1", `l${index}`, CREATED_AT + index),
        CREATED_AT,
      ).state;
    }
    expect(state.pending).toHaveLength(MAX_LINES);

    const overflowing = Trigger.Notifier.observe(
      state,
      line("t1", "dropped", CREATED_AT),
      CREATED_AT,
    );
    expect(overflowing.state.pending).toHaveLength(MAX_LINES);
    expect(overflowing.state.overflow.t1).toBe(1);
    expect(overflowing.effects).toEqual([]);
  });

  test("admission past the rendered character budget counts overflow", () => {
    const text = "x".repeat(Trigger.Constants.MAX_EVENT_TEXT_CHARS);
    const perItem = "line".length + text.length + 4;
    const fits = Math.floor((MAX_CHARS - OVERHEAD) / perItem);
    let state = Trigger.Notifier.initialState();
    for (let index = 0; index < fits; index += 1) {
      state = Trigger.Notifier.observe(state, line("t1", text, CREATED_AT), CREATED_AT).state;
    }
    expect(state.pending).toHaveLength(fits);
    expect(state.eventChars).toBeLessThanOrEqual(MAX_CHARS - OVERHEAD);

    const rejected = Trigger.Notifier.observe(state, line("t1", text, CREATED_AT), CREATED_AT);
    expect(rejected.state.pending).toHaveLength(fits);
    expect(rejected.state.overflow.t1).toBe(1);
  });

  test("an overflow-only group still flushes a bounded disclosure", () => {
    const text = "x".repeat(Trigger.Constants.MAX_EVENT_TEXT_CHARS);
    const perItem = "line".length + text.length + 4;
    const fits = Math.floor((MAX_CHARS - OVERHEAD) / perItem);
    let state = Trigger.Notifier.initialState();
    for (let index = 0; index < fits; index += 1) {
      state = Trigger.Notifier.observe(state, line("filler", text, CREATED_AT), CREATED_AT).state;
    }
    // A different trigger now overflows with nothing queued of its own.
    const overflowed = Trigger.Notifier.observe(
      state,
      line("t-late", text, CREATED_AT),
      CREATED_AT,
    );
    expect(overflowed.state.overflow["t-late"]).toBe(1);

    const emitted = emits(Trigger.Notifier.flush(overflowed.state, CREATED_AT + WINDOW).effects);
    const lateGroup = emitted.find((effect) => effect.triggerId === "t-late");
    expect(lateGroup?.items).toEqual([]);
    expect(lateGroup?.overflowCount).toBe(1);
  });

  test("the first overflowing event of an empty queue still schedules a flush", () => {
    const text = "x".repeat(Trigger.Constants.MAX_EVENT_TEXT_CHARS);
    const oversized: Trigger.Notifier.Event = {
      triggerId: "t1",
      kind: "line",
      text,
      at: CREATED_AT,
    };
    // Fill the character budget on one trigger, drain the queue, keep overflow.
    const perItem = "line".length + text.length + 4;
    const fits = Math.floor((MAX_CHARS - OVERHEAD) / perItem);
    let state = Trigger.Notifier.initialState();
    for (let index = 0; index < fits; index += 1) {
      state = Trigger.Notifier.observe(state, oversized, CREATED_AT).state;
    }
    const drained = Trigger.Notifier.flush(state, CREATED_AT + WINDOW).state;
    expect(drained.pending).toHaveLength(0);

    // Now the queue is empty again and the next event schedules its own flush.
    const next = Trigger.Notifier.observe(
      drained,
      line("t2", "hello", CREATED_AT + 10),
      CREATED_AT + 10,
    );
    expect(next.effects).toEqual([{ type: "schedule_flush", dueAt: CREATED_AT + 10 + WINDOW }]);
  });
});

describe("Trigger notifier — rate limit and fingerprint", () => {
  test("a second batch inside the rate window is retained and rescheduled", () => {
    const first = Trigger.Notifier.flush(
      Trigger.Notifier.observe(
        Trigger.Notifier.initialState(),
        line("t1", "a", CREATED_AT),
        CREATED_AT,
      ).state,
      CREATED_AT + WINDOW,
    );
    expect(emits(first.effects)).toHaveLength(1);
    const injectedAt = CREATED_AT + WINDOW;

    const queued = Trigger.Notifier.observe(
      first.state,
      line("t1", "b", injectedAt + 1),
      injectedAt + 1,
    ).state;
    const early = Trigger.Notifier.flush(queued, injectedAt + 1_000);
    expect(emits(early.effects)).toHaveLength(0);
    expect(early.state.pending).toHaveLength(1);
    expect(early.effects).toEqual([{ type: "schedule_rate_limit", dueAt: injectedAt + RATE }]);

    // Exactly at the boundary the trigger becomes ready again.
    const ready = Trigger.Notifier.flush(queued, injectedAt + RATE);
    expect(emits(ready.effects)).toHaveLength(1);
  });

  test("an identical line batch is fingerprint-suppressed without a wake", () => {
    const firstAt = CREATED_AT;
    const first = Trigger.Notifier.flush(
      Trigger.Notifier.observe(
        Trigger.Notifier.initialState(),
        line("t1", "same", firstAt),
        firstAt,
      ).state,
      firstAt + WINDOW,
    );
    const injectedAt = firstAt + WINDOW;
    expect(emits(first.effects)).toHaveLength(1);
    expect(first.state.lastBatchFingerprint.t1).toBe(
      canonicalDigest({ triggerId: "t1", lines: ["same"] }),
    );

    const repeatAt = injectedAt + RATE;
    const repeated = Trigger.Notifier.observe(
      first.state,
      line("t1", "same", repeatAt),
      repeatAt,
    ).state;
    const result = Trigger.Notifier.flush(repeated, repeatAt);
    expect(emits(result.effects)).toHaveLength(0);
    expect(result.state.pending).toHaveLength(0);
    expect(result.state.consecutiveWakes).toBe(first.state.consecutiveWakes);
  });

  test("a batch carrying overflow is never fingerprint-suppressed", () => {
    const firstAt = CREATED_AT;
    const first = Trigger.Notifier.flush(
      Trigger.Notifier.observe(
        Trigger.Notifier.initialState(),
        line("t1", "same", firstAt),
        firstAt,
      ).state,
      firstAt + WINDOW,
    );
    const repeatAt = firstAt + WINDOW + RATE;
    const withOverflow = Trigger.Notifier.observe(
      { ...first.state, overflow: { t1: 2 } },
      line("t1", "same", repeatAt),
      repeatAt,
    ).state;
    const emitted = emits(Trigger.Notifier.flush(withOverflow, repeatAt).effects);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.overflowCount).toBe(2);
  });

  test("explicit rearm clears the per-trigger fingerprint and rate memory", () => {
    const firstAt = CREATED_AT;
    const first = Trigger.Notifier.flush(
      Trigger.Notifier.observe(
        Trigger.Notifier.initialState(),
        line("t1", "same", firstAt),
        firstAt,
      ).state,
      firstAt + WINDOW,
    );
    const rearmed = Trigger.Notifier.rearm(first.state, "t1");
    expect(rearmed.state.lastBatchFingerprint.t1).toBeUndefined();
    expect(rearmed.state.lastInjectionAt.t1).toBeUndefined();
    expect(rearmed.state.wakeBudgetPaused).toBe(false);
    expect(rearmed.state.consecutiveWakes).toBe(0);
    expect(rearmed.effects).toEqual([]);

    // The identical line is now eligible immediately.
    const at = firstAt + WINDOW + 1;
    const requeued = Trigger.Notifier.observe(rearmed.state, line("t1", "same", at), at).state;
    expect(emits(Trigger.Notifier.flush(requeued, at).effects)).toHaveLength(1);
  });
});

describe("Trigger notifier — terminal bypass", () => {
  test("a summary emits immediately, ignoring the queue window and rate limit", () => {
    const firstAt = CREATED_AT;
    const injected = Trigger.Notifier.flush(
      Trigger.Notifier.observe(Trigger.Notifier.initialState(), line("t1", "a", firstAt), firstAt)
        .state,
      firstAt + WINDOW,
    ).state;

    const at = firstAt + WINDOW + 1;
    const result = Trigger.Notifier.observe(injected, summary("t1", "exit 0", at), at);
    const emitted = emits(result.effects);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.terminal).toBe(true);
    expect(emitted[0]?.items).toEqual([{ kind: "summary", text: "exit 0", at }]);
    expect(result.state.consecutiveWakes).toBe(0);
  });

  test("a summary discards that trigger's deferred lines and carries their overflow", () => {
    const at = CREATED_AT + 5;
    const queued = observeAll(Trigger.Notifier.initialState(), [
      [line("t1", "deferred", CREATED_AT), CREATED_AT],
      [line("t2", "other", CREATED_AT + 1), CREATED_AT + 1],
    ]);
    const withOverflow = { ...queued, overflow: { t1: 7 } };

    const result = Trigger.Notifier.observe(withOverflow, summary("t1", "done", at), at);
    expect(emits(result.effects)[0]?.overflowCount).toBe(7);
    expect(result.state.pending.map((event) => event.triggerId)).toEqual(["t2"]);
    expect(result.state.overflow.t1).toBeUndefined();
    expect(result.state.eventChars).toBe("line".length + "other".length + 4);
  });

  test("a summary clears an active wake pause", () => {
    const paused = { ...Trigger.Notifier.initialState(), wakeBudgetPaused: true };
    const result = Trigger.Notifier.observe(
      paused,
      summary("t1", "safety error", CREATED_AT),
      CREATED_AT,
    );
    expect(result.state.wakeBudgetPaused).toBe(false);
    expect(emits(result.effects)).toHaveLength(1);
  });
});

describe("Trigger notifier — wake budget", () => {
  function wakeStreak(count: number): Trigger.Notifier.Result {
    let state = Trigger.Notifier.initialState();
    let result: Trigger.Notifier.Result = { state, effects: [] };
    for (let index = 0; index < count; index += 1) {
      // Distinct triggers avoid the per-trigger rate limit; every flush is a
      // fresh line-only injection, so this is one consecutive wake streak.
      const at = CREATED_AT + index * RATE;
      state = Trigger.Notifier.observe(state, line(`t${index}`, `line ${index}`, at), at).state;
      result = Trigger.Notifier.flush(state, at + WINDOW);
      state = result.state;
    }
    return result;
  }

  test("the fifth consecutive line-only injection carries the pause notice", () => {
    const fourth = wakeStreak(WAKE_BUDGET - 1);
    expect(fourth.state.consecutiveWakes).toBe(WAKE_BUDGET - 1);
    expect(fourth.state.wakeBudgetPaused).toBe(false);
    expect(emits(fourth.effects)[0]?.pauseNotice).toBe(false);

    const fifth = wakeStreak(WAKE_BUDGET);
    expect(fifth.state.wakeBudgetPaused).toBe(true);
    expect(emits(fifth.effects)[0]?.pauseNotice).toBe(true);
    expect(fifth.effects.some((effect) => effect.type === "pause_event_triggers")).toBe(true);
  });

  test("while paused, further lines are dropped and not counted as overflow", () => {
    const paused = wakeStreak(WAKE_BUDGET).state;
    const at = CREATED_AT + WAKE_BUDGET * RATE + 1;
    const dropped = Trigger.Notifier.observe(paused, line("t-new", "ignored", at), at);
    expect(dropped.state).toEqual(paused);
    expect(dropped.state.overflow["t-new"]).toBeUndefined();
    expect(dropped.effects).toEqual([]);
  });

  test("a flush during a wake pause emits nothing further", () => {
    const paused = wakeStreak(WAKE_BUDGET).state;
    const queued = { ...paused, pending: [line("t-x", "queued before pause", CREATED_AT)] };
    const result = Trigger.Notifier.flush(queued, CREATED_AT + WAKE_BUDGET * RATE + WINDOW);
    expect(emits(result.effects)).toHaveLength(0);
  });

  test("user activity resets the streak and clears the pause", () => {
    const paused = wakeStreak(WAKE_BUDGET).state;
    const at = CREATED_AT + WAKE_BUDGET * RATE + 10;
    const reset = Trigger.Notifier.noteActivity(paused, at);
    expect(reset.state.consecutiveWakes).toBe(0);
    expect(reset.state.wakeBudgetPaused).toBe(false);
    expect(reset.state.lastWakeAt).toBe(at);
    expect(reset.effects).toEqual([]);
  });

  test("a quiet gap of two rate windows resets the streak before the next wake", () => {
    const third = wakeStreak(3);
    expect(third.state.consecutiveWakes).toBe(3);

    const quietAt = (third.state.lastWakeAt ?? CREATED_AT) + RATE * QUIET_GAP + 1;
    const queued = Trigger.Notifier.observe(
      third.state,
      line("t-quiet", "after quiet", quietAt),
      quietAt,
    ).state;
    const result = Trigger.Notifier.flush(queued, quietAt);
    expect(result.state.consecutiveWakes).toBe(1);
    expect(emits(result.effects)[0]?.pauseNotice).toBe(false);
  });

  test("a gap shorter than the quiet threshold keeps the streak", () => {
    const third = wakeStreak(3);
    const soonAt = (third.state.lastWakeAt ?? CREATED_AT) + RATE * QUIET_GAP;
    const queued = Trigger.Notifier.observe(
      third.state,
      line("t-soon", "still hot", soonAt),
      soonAt,
    ).state;
    const result = Trigger.Notifier.flush(queued, soonAt);
    expect(result.state.consecutiveWakes).toBe(4);
  });

  test("later line-only groups in the same flush are dropped once the pause wins", () => {
    let state = Trigger.Notifier.initialState();
    for (let index = 0; index < WAKE_BUDGET - 1; index += 1) {
      const at = CREATED_AT + index * RATE;
      state = Trigger.Notifier.observe(state, line(`w${index}`, `w${index}`, at), at).state;
      state = Trigger.Notifier.flush(state, at + WINDOW).state;
    }
    expect(state.consecutiveWakes).toBe(WAKE_BUDGET - 1);

    const at = CREATED_AT + WAKE_BUDGET * RATE;
    state = observeAll(state, [
      [line("a-fifth", "fifth wake", at), at],
      [line("b-sixth", "would be sixth", at + 1), at + 1],
    ]);
    const result = Trigger.Notifier.flush(state, at + WINDOW);
    const emitted = emits(result.effects);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.triggerId).toBe("a-fifth");
    expect(emitted[0]?.pauseNotice).toBe(true);
    expect(result.state.wakeBudgetPaused).toBe(true);
    // The deferred sixth group is dropped rather than kept as a hidden queue.
    expect(result.state.pending.filter((event) => event.kind === "line")).toHaveLength(0);
  });
});

describe("Trigger notifier — lifecycle helpers", () => {
  test("dispose returns pristine suppression state", () => {
    const dirty = observeAll(Trigger.Notifier.initialState(), [
      [line("t1", "a", CREATED_AT), CREATED_AT],
    ]);
    expect(Trigger.Notifier.dispose(dirty).state).toEqual(Trigger.Notifier.initialState());
  });

  test("malformed state or events are rejected before any fold runs", () => {
    expect(() =>
      Trigger.Notifier.observe(
        { ...Trigger.Notifier.initialState(), consecutiveWakes: -1 },
        line("t1", "a", CREATED_AT),
        CREATED_AT,
      ),
    ).toThrow();
    expect(() =>
      Trigger.Notifier.observe(
        Trigger.Notifier.initialState(),
        { triggerId: "t1", kind: "line", text: "", at: CREATED_AT },
        CREATED_AT,
      ),
    ).toThrow();
  });
});
