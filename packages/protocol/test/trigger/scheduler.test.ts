import { describe, expect, test } from "bun:test";
import { canonicalDigest } from "../../src/json.js";
import { Trigger } from "../../src/trigger/index.js";
import {
  buildAlarmMaterial,
  buildBatch,
  buildCommandRecord,
  buildEveryRecord,
  buildFileRecord,
  buildMaterial,
  buildOnceRecord,
  buildReservation,
  buildScheduleMarker,
  buildTerminalBatch,
  CREATED_AT,
  required,
} from "../helpers/trigger.js";

const INTERVAL = Trigger.Constants.MIN_RECURRING_INTERVAL_MS;

function effectTypes(result: Trigger.SchedulerEffect[] | readonly Trigger.SchedulerEffect[]) {
  return result.map((effect) => effect.type);
}

function expectRefusal(run: () => unknown, fragment?: string): void {
  let raised: unknown;
  try {
    run();
  } catch (error) {
    raised = error;
  }
  expect(Trigger.StoreError.isInstance(raised)).toBe(true);
  if (!Trigger.StoreError.isInstance(raised)) throw new Error("expected a typed refusal");
  expect(raised.data.code).toBe("invalid_transition");
  if (fragment !== undefined) expect(raised.message).toContain(fragment);
}

describe("Trigger scheduler — time.once", () => {
  test("an early callback re-arms the same deadline and mutates nothing", () => {
    const record = buildOnceRecord();
    const dueAt = CREATED_AT + 60_000;
    const result = Trigger.Scheduler.step(record, {
      type: "timer_due",
      at: CREATED_AT + 1_000,
      fireMaterial: buildAlarmMaterial(dueAt, CREATED_AT + 1_000),
    });

    expect(result.record).toEqual(record);
    expect(result.effects).toEqual([{ type: "arm", dueAt }]);
  });

  test("a due callback reserves exactly one Fire and ends completed", () => {
    const record = buildOnceRecord();
    const dueAt = CREATED_AT + 60_000;
    const result = Trigger.Scheduler.step(record, {
      type: "timer_due",
      at: dueAt,
      fireMaterial: buildAlarmMaterial(dueAt, dueAt, { id: "fire-once" }),
    });

    expect(result.record.inFlightFireId).toBe("fire-once");
    expect(result.record.fireCount).toBe(1);
    expect(result.record.lastFiredAt).toBe(dueAt);
    expect(result.record.lifecycle).toEqual({
      state: "ended",
      endReason: "completed",
      endedAt: dueAt,
    });
    expect(effectTypes(result.effects)).toEqual(["reserve_fire", "cancel_timer", "end"]);
  });

  test("a late once alarm still fires exactly once, then refuses a second callback", () => {
    const record = buildOnceRecord();
    const dueAt = CREATED_AT + 60_000;
    const late = dueAt + 86_400_000;
    const first = Trigger.Scheduler.step(record, {
      type: "timer_due",
      at: late,
      fireMaterial: buildAlarmMaterial(dueAt, late, { id: "fire-late" }),
    });
    expect(first.record.fireCount).toBe(1);

    const second = Trigger.Scheduler.step(first.record, {
      type: "timer_due",
      at: late + 1_000,
      fireMaterial: buildAlarmMaterial(dueAt, late + 1_000, { id: "fire-second" }),
    });
    expect(second.record).toEqual(first.record);
    expect(effectTypes(second.effects)).toEqual(["cancel_timer"]);
  });

  test("input state is never mutated in place", () => {
    const record = buildOnceRecord();
    const snapshot = structuredClone(record);
    Trigger.Scheduler.step(record, {
      type: "timer_due",
      at: CREATED_AT + 60_000,
      fireMaterial: buildAlarmMaterial(CREATED_AT + 60_000, CREATED_AT + 60_000),
    });
    expect(record).toEqual(snapshot);
  });
});

describe("Trigger scheduler — time.every", () => {
  test("a due recurring callback reserves one Fire and recomputes from logical now", () => {
    const record = buildEveryRecord();
    const at = CREATED_AT + INTERVAL + 7_000;
    const result = Trigger.Scheduler.step(record, {
      type: "timer_due",
      at,
      fireMaterial: buildAlarmMaterial(required(record.nextFireAt, "nextFireAt"), at, {
        id: "fire-r1",
      }),
    });

    expect(result.record.inFlightFireId).toBe("fire-r1");
    expect(result.record.nextFireAt).toBe(at + INTERVAL);
    expect(result.record.lifecycle.state).toBe("armed");
    expect(result.effects).toEqual([
      { type: "reserve_fire", fireId: "fire-r1" },
      { type: "arm", dueAt: at + INTERVAL },
    ]);
  });

  test("many missed periods collapse into exactly one catch-up Fire", () => {
    const record = buildEveryRecord();
    const at = CREATED_AT + INTERVAL * 40;
    const result = Trigger.Scheduler.step(record, {
      type: "timer_due",
      at,
      fireMaterial: buildAlarmMaterial(required(record.nextFireAt, "nextFireAt"), at, {
        id: "fire-catchup",
      }),
    });

    expect(result.record.fireCount).toBe(1);
    expect(result.record.nextFireAt).toBe(at + INTERVAL);
  });

  test("expiry is inclusive: no Fire is reserved at or after expiresAt", () => {
    const record = buildEveryRecord();
    const at = required(record.expiresAt, "expiresAt");
    const result = Trigger.Scheduler.step(record, {
      type: "timer_due",
      at,
      fireMaterial: buildAlarmMaterial(required(record.nextFireAt, "nextFireAt"), at),
    });

    expect(result.record.fireCount).toBe(0);
    expect(result.record.inFlightFireId).toBeUndefined();
    expect(result.record.lifecycle).toEqual({
      state: "ended",
      endReason: "expired",
      endedAt: at,
    });
    expect(effectTypes(result.effects)).toEqual(["cancel_timer", "end"]);
  });

  test("the last legal occurrence fires and ends expired in one transition", () => {
    const record = buildEveryRecord();
    const at = required(record.expiresAt, "expiresAt") - Math.floor(INTERVAL / 2);
    const result = Trigger.Scheduler.step(record, {
      type: "timer_due",
      at,
      fireMaterial: buildAlarmMaterial(required(record.nextFireAt, "nextFireAt"), at, {
        id: "fire-last",
      }),
    });

    expect(result.record.inFlightFireId).toBe("fire-last");
    expect(result.record.nextFireAt).toBe(record.expiresAt);
    expect(result.record.lifecycle.state).toBe("ended");
    expect(effectTypes(result.effects)).toEqual(["reserve_fire", "cancel_timer", "end"]);
  });

  test("a due occurrence behind an in-flight Fire coalesces into one schedule marker", () => {
    const inFlight = buildEveryRecord({ inFlightFireId: "fire-open" });
    const at = CREATED_AT + INTERVAL;
    const first = Trigger.Scheduler.step(inFlight, {
      type: "timer_due",
      at,
      fireMaterial: buildAlarmMaterial(at, at, { id: "fire-ignored" }),
    });

    expect(first.record.inFlightFireId).toBe("fire-open");
    expect(first.record.fireCount).toBe(0);
    expect(first.record.coalescedFirePending).toBe(true);
    expect(first.record.pendingBatch?.scheduleMarker).toBe(true);
    expect(first.record.pendingBatch?.scheduledForAt).toBe(at);
    expect(effectTypes(first.effects)).toEqual(["arm"]);

    // A second missed occurrence advances the marker rather than adding a Fire.
    const later = at + INTERVAL;
    const second = Trigger.Scheduler.step(first.record, {
      type: "timer_due",
      at: later,
      fireMaterial: buildAlarmMaterial(later, later, { id: "fire-ignored-2" }),
    });
    expect(second.record.pendingBatch?.scheduledForAt).toBe(later);
    expect(second.record.pendingBatch?.lastAt).toBe(later);
    expect(second.record.fireCount).toBe(0);
  });

  test("a paused recurring Trigger cancels its stale handle without firing", () => {
    const paused = buildEveryRecord({
      lifecycle: { state: "paused", pauseReason: "wake_budget", pausedAt: CREATED_AT },
    });
    const at = CREATED_AT + INTERVAL;
    const result = Trigger.Scheduler.step(paused, {
      type: "timer_due",
      at,
      fireMaterial: buildAlarmMaterial(at, at),
    });
    expect(result.record).toEqual(paused);
    expect(effectTypes(result.effects)).toEqual(["cancel_timer"]);
  });

  test("a timer callback before the recorded due instant re-arms without firing", () => {
    const record = buildEveryRecord();
    const at = CREATED_AT + 1;
    const result = Trigger.Scheduler.step(record, {
      type: "timer_due",
      at,
      fireMaterial: buildAlarmMaterial(required(record.nextFireAt, "nextFireAt"), at),
    });
    expect(result.record).toEqual(record);
    expect(result.effects).toEqual([
      { type: "arm", dueAt: required(record.nextFireAt, "nextFireAt") },
    ]);
  });
});

describe("Trigger scheduler — logical clock monotonicity", () => {
  test("a wall-clock rollback cannot move the schedule backwards or fire early", () => {
    const record = buildEveryRecord({
      lastObservedAt: CREATED_AT + INTERVAL * 3,
      updatedAt: CREATED_AT + INTERVAL * 3,
      nextFireAt: CREATED_AT + INTERVAL * 4,
    });
    const rolledBack = CREATED_AT + 10;
    const result = Trigger.Scheduler.step(record, {
      type: "timer_due",
      at: rolledBack,
      fireMaterial: buildAlarmMaterial(required(record.nextFireAt, "nextFireAt"), rolledBack),
    });

    // logicalNow = max(now, lastObservedAt) = CREATED_AT + 3*INTERVAL < nextFireAt.
    expect(result.record).toEqual(record);
    expect(result.effects).toEqual([
      { type: "arm", dueAt: required(record.nextFireAt, "nextFireAt") },
    ]);
  });

  test("a rolled-back observation is recorded at the logical watermark", () => {
    const record = buildCommandRecord({
      lastObservedAt: CREATED_AT + 50_000,
      updatedAt: CREATED_AT + 50_000,
    });
    const batch = buildBatch({
      items: [{ kind: "line", text: "observed", at: CREATED_AT + 60_000 }],
      firstAt: CREATED_AT + 60_000,
      lastAt: CREATED_AT + 60_000,
    });
    const result = Trigger.Scheduler.step(record, {
      type: "source_observation",
      batch,
      at: CREATED_AT + 5,
      fireMaterial: buildMaterial(batch, { id: "fire-line" }),
    });
    expect(result.record.lastObservedAt).toBe(CREATED_AT + 50_000);
  });
});

describe("Trigger scheduler — event sources", () => {
  test("a line observation with no Fire in flight reserves one", () => {
    const record = buildCommandRecord();
    const batch = buildBatch();
    const result = Trigger.Scheduler.step(record, {
      type: "source_observation",
      batch,
      at: CREATED_AT + 1_000,
      fireMaterial: buildMaterial(batch, { id: "fire-line" }),
    });

    expect(result.record.inFlightFireId).toBe("fire-line");
    expect(result.record.coalescedFirePending).toBe(false);
    expect(result.effects).toEqual([{ type: "reserve_fire", fireId: "fire-line" }]);
  });

  test("a line observation behind an in-flight Fire coalesces durably", () => {
    const record = buildCommandRecord({ inFlightFireId: "fire-open" });
    const batch = buildBatch({
      items: [{ kind: "line", text: "second line", at: CREATED_AT + 5 }],
      firstAt: CREATED_AT + 5,
      lastAt: CREATED_AT + 5,
    });
    const result = Trigger.Scheduler.step(record, {
      type: "source_observation",
      batch,
      at: CREATED_AT + 5,
      fireMaterial: buildMaterial(batch, { id: "fire-ignored" }),
    });

    expect(result.record.inFlightFireId).toBe("fire-open");
    expect(result.record.coalescedFirePending).toBe(true);
    expect(result.record.pendingBatch?.items).toHaveLength(1);
    expect(result.effects).toEqual([]);
  });

  test("coalesced line batches merge in arrival order and count omitted overflow", () => {
    const record = buildCommandRecord({ inFlightFireId: "fire-open" });
    let current = record;
    for (let index = 0; index < 3; index += 1) {
      const at = CREATED_AT + index + 1;
      const batch = buildBatch({
        items: [{ kind: "line", text: `line-${index}`, at }],
        firstAt: at,
        lastAt: at,
      });
      current = Trigger.Scheduler.step(current, {
        type: "source_observation",
        batch,
        at,
        fireMaterial: buildMaterial(batch, { id: `fire-${index}` }),
      }).record;
    }
    expect(current.pendingBatch?.items.map((item) => item.text)).toEqual([
      "line-0",
      "line-1",
      "line-2",
    ]);
    expect(current.pendingBatch?.overflowCount).toBe(0);
    expect(current.pendingBatch?.firstAt).toBe(CREATED_AT + 1);
    expect(current.pendingBatch?.lastAt).toBe(CREATED_AT + 3);
  });

  test("merging past the line cap counts the omitted items as overflow", () => {
    const cap = Trigger.Constants.NOTIFIER_MAX_LINES;
    const full = buildBatch({
      items: Array.from({ length: cap }, (_unused, index) => ({
        kind: "line" as const,
        text: `l${index}`,
        at: CREATED_AT + 1,
      })),
      firstAt: CREATED_AT + 1,
      lastAt: CREATED_AT + 1,
    });
    const record = buildCommandRecord({
      inFlightFireId: "fire-open",
      pendingBatch: full,
      coalescedFirePending: true,
    });
    const extra = buildBatch({
      items: [{ kind: "line", text: "overflowing", at: CREATED_AT + 2 }],
      firstAt: CREATED_AT + 2,
      lastAt: CREATED_AT + 2,
    });
    const result = Trigger.Scheduler.step(record, {
      type: "source_observation",
      batch: extra,
      at: CREATED_AT + 2,
      fireMaterial: buildMaterial(extra, { id: "fire-x" }),
    });

    expect(result.record.pendingBatch?.items).toHaveLength(cap);
    expect(result.record.pendingBatch?.overflowCount).toBe(1);
  });

  test("a terminal source summary reserves the Fire and ends in one transition", () => {
    const record = buildCommandRecord();
    const at = CREATED_AT + 2_000;
    const batch = buildTerminalBatch("source_exited", at, "exited with code 0");
    const result = Trigger.Scheduler.step(record, {
      type: "source_observation",
      batch,
      at,
      terminalReason: "source_exited",
      fireMaterial: buildMaterial(batch, { id: "fire-summary" }),
    });

    expect(result.record.inFlightFireId).toBe("fire-summary");
    expect(result.record.lifecycle).toEqual({
      state: "ended",
      endReason: "source_exited",
      endedAt: at,
    });
    expect(effectTypes(result.effects)).toEqual(["reserve_fire", "cancel_timer", "end"]);
  });

  test("a terminal summary behind an in-flight Fire replaces ordinary pending lines", () => {
    const pending = buildBatch({
      items: [{ kind: "line", text: "noise", at: CREATED_AT + 1 }],
      firstAt: CREATED_AT + 1,
      lastAt: CREATED_AT + 1,
    });
    const record = buildCommandRecord({
      inFlightFireId: "fire-open",
      pendingBatch: pending,
      coalescedFirePending: true,
    });
    const at = CREATED_AT + 9;
    const terminal = buildTerminalBatch("source_timeout", at, "timed out");
    const result = Trigger.Scheduler.step(record, {
      type: "source_closed",
      reason: "source_timeout",
      at,
      terminalBatch: terminal,
      fireMaterial: buildMaterial(terminal, { id: "fire-terminal" }),
    });

    expect(result.record.pendingBatch?.terminalReason).toBe("source_timeout");
    expect(result.record.pendingBatch?.items.map((item) => item.kind)).toEqual(["summary"]);
    expect(result.record.lifecycle).toMatchObject({
      state: "ended",
      endReason: "source_timeout",
    });
  });

  test("a losing terminal callback on an already-ended Trigger is a no-op", () => {
    const ended = buildCommandRecord({
      lifecycle: { state: "ended", endReason: "cancelled", endedAt: CREATED_AT + 3 },
    });
    const at = CREATED_AT + 4;
    const terminal = buildTerminalBatch("source_exited", at);
    const result = Trigger.Scheduler.step(ended, {
      type: "source_closed",
      reason: "source_exited",
      at,
      terminalBatch: terminal,
      fireMaterial: buildMaterial(terminal),
    });
    expect(result.record).toEqual(ended);
    expect(result.effects).toEqual([]);
  });

  test("a source observation at or after the inclusive expiry is refused", () => {
    const record = buildCommandRecord();
    const at = required(record.expiresAt, "expiresAt");
    const batch = buildBatch({
      items: [{ kind: "line", text: "too late", at }],
      firstAt: at,
      lastAt: at,
    });
    expectRefusal(
      () =>
        Trigger.Scheduler.step(record, {
          type: "source_observation",
          batch,
          at,
          fireMaterial: buildMaterial(batch),
        }),
      "inclusive expiry",
    );
  });

  test("a terminal batch whose reason contradicts the transition is refused", () => {
    const record = buildCommandRecord();
    const at = CREATED_AT + 5;
    const batch = buildTerminalBatch("source_exited", at);
    expectRefusal(
      () =>
        Trigger.Scheduler.step(record, {
          type: "source_closed",
          reason: "source_timeout",
          at,
          terminalBatch: batch,
          fireMaterial: buildMaterial(batch),
        }),
      "terminal batch reason",
    );
  });

  test("Fire material that describes another observation is refused", () => {
    const record = buildCommandRecord();
    const batch = buildBatch();
    const other = buildBatch({
      items: [{ kind: "line", text: "different", at: CREATED_AT }],
    });
    expectRefusal(
      () =>
        Trigger.Scheduler.step(record, {
          type: "source_observation",
          batch,
          at: CREATED_AT + 1,
          fireMaterial: buildMaterial(other),
        }),
      "does not describe the observation batch",
    );
  });

  test("a source observation requires an armed event Trigger", () => {
    const batch = buildBatch();
    const material = buildMaterial(batch);
    expectRefusal(
      () =>
        Trigger.Scheduler.step(
          buildCommandRecord({
            lifecycle: { state: "paused", pauseReason: "wake_budget", pausedAt: CREATED_AT },
          }),
          { type: "source_observation", batch, at: CREATED_AT + 1, fireMaterial: material },
        ),
      "requires armed Trigger",
    );
    expectRefusal(
      () =>
        Trigger.Scheduler.step(buildOnceRecord(), {
          type: "source_observation",
          batch,
          at: CREATED_AT + 1,
          fireMaterial: material,
        }),
      "time Trigger received source observation",
    );
  });

  test("a time Trigger cannot receive a source closure and an event Trigger no timer", () => {
    const batch = buildTerminalBatch("cancelled", CREATED_AT + 1);
    expectRefusal(
      () =>
        Trigger.Scheduler.step(buildOnceRecord(), {
          type: "source_closed",
          reason: "cancelled",
          at: CREATED_AT + 1,
          terminalBatch: batch,
          fireMaterial: buildMaterial(batch),
        }),
      "time Trigger received source closure",
    );
    expectRefusal(
      () =>
        Trigger.Scheduler.step(buildCommandRecord(), {
          type: "timer_due",
          at: CREATED_AT + 1,
          fireMaterial: buildAlarmMaterial(CREATED_AT + 1, CREATED_AT + 1),
        }),
      "event Trigger received timer_due",
    );
  });
});

describe("Trigger scheduler — pause, rearm, and cancel", () => {
  test("pausing a time source cancels its schedule", () => {
    const record = buildEveryRecord();
    const at = CREATED_AT + 5_000;
    const result = Trigger.Scheduler.step(record, {
      type: "pause",
      reason: "wake_budget",
      at,
    });
    expect(result.record.lifecycle).toEqual({
      state: "paused",
      pauseReason: "wake_budget",
      pausedAt: at,
    });
    expect(effectTypes(result.effects)).toEqual(["cancel_timer", "pause_source"]);
  });

  test("pausing a finite event source keeps only its absolute timeout armed", () => {
    const record = buildCommandRecord();
    const at = CREATED_AT + 5_000;
    const result = Trigger.Scheduler.step(record, {
      type: "pause",
      reason: "source_unavailable",
      at,
    });
    expect(result.effects).toEqual([
      { type: "arm", dueAt: required(record.expiresAt, "expiresAt") },
      { type: "pause_source" },
    ]);
  });

  test("pausing a persistent command arms no deadline at all", () => {
    const persistent = buildCommandRecord({
      source: { kind: "event.command", command: "tail -f build.log", persistent: true },
      expiresAt: undefined,
    });
    const result = Trigger.Scheduler.step(persistent, {
      type: "pause",
      reason: "wake_budget",
      at: CREATED_AT + 10,
    });
    expect(effectTypes(result.effects)).toEqual(["pause_source"]);
  });

  test("pause is idempotent and an ended Trigger refuses it", () => {
    const paused = buildCommandRecord({
      lifecycle: { state: "paused", pauseReason: "wake_budget", pausedAt: CREATED_AT },
    });
    const again = Trigger.Scheduler.step(paused, {
      type: "pause",
      reason: "source_unavailable",
      at: CREATED_AT + 1,
    });
    expect(again.record).toEqual(paused);
    expect(again.effects).toEqual([]);

    expectRefusal(
      () =>
        Trigger.Scheduler.step(
          buildCommandRecord({
            lifecycle: { state: "ended", endReason: "cancelled", endedAt: CREATED_AT },
          }),
          { type: "pause", reason: "wake_budget", at: CREATED_AT + 1 },
        ),
      "ended Trigger cannot pause",
    );
  });

  test("rearm recomputes a recurring schedule from the current logical time", () => {
    const paused = buildEveryRecord({
      lifecycle: { state: "paused", pauseReason: "wake_budget", pausedAt: CREATED_AT },
    });
    const at = CREATED_AT + INTERVAL * 5;
    const result = Trigger.Scheduler.step(paused, { type: "rearm", at });
    expect(result.record.lifecycle).toEqual({ state: "armed" });
    expect(result.record.nextFireAt).toBe(at + INTERVAL);
    expect(result.effects).toEqual([{ type: "arm", dueAt: at + INTERVAL }]);
  });

  test("rearm retains the original once due instant", () => {
    const paused = buildOnceRecord({
      lifecycle: { state: "paused", pauseReason: "owner_session_missing", pausedAt: CREATED_AT },
    });
    const result = Trigger.Scheduler.step(paused, { type: "rearm", at: CREATED_AT + 100 });
    expect(result.effects).toEqual([{ type: "arm", dueAt: CREATED_AT + 60_000 }]);
  });

  test("rearming an event source re-activates it under the retained timeout", () => {
    const paused = buildFileRecord({
      lifecycle: { state: "paused", pauseReason: "source_unavailable", pausedAt: CREATED_AT },
    });
    const result = Trigger.Scheduler.step(paused, { type: "rearm", at: CREATED_AT + 10 });
    expect(result.effects).toEqual([
      { type: "arm", dueAt: required(paused.expiresAt, "expiresAt") },
      { type: "activate_source" },
    ]);
  });

  test("rearm past a recurring expiry ends expired instead of resurrecting", () => {
    const paused = buildEveryRecord({
      lifecycle: { state: "paused", pauseReason: "wake_budget", pausedAt: CREATED_AT },
    });
    const at = required(paused.expiresAt, "expiresAt");
    const result = Trigger.Scheduler.step(paused, { type: "rearm", at });
    expect(result.record.lifecycle).toMatchObject({ state: "ended", endReason: "expired" });
    expect(effectTypes(result.effects)).toEqual(["end"]);
  });

  test("rearm of a finite event source at expiry demands restore timeout material", () => {
    const paused = buildCommandRecord({
      lifecycle: { state: "paused", pauseReason: "wake_budget", pausedAt: CREATED_AT },
    });
    expectRefusal(
      () =>
        Trigger.Scheduler.step(paused, {
          type: "rearm",
          at: required(paused.expiresAt, "expiresAt"),
        }),
      "requires restore timeout material",
    );
  });

  test("only a paused Trigger can rearm", () => {
    expectRefusal(
      () => Trigger.Scheduler.step(buildOnceRecord(), { type: "rearm", at: CREATED_AT + 1 }),
      "only a paused Trigger can rearm",
    );
  });

  test("cancelling a time source discards an unreserved schedule marker", () => {
    const marker = buildScheduleMarker(CREATED_AT + INTERVAL, CREATED_AT + INTERVAL);
    const record = buildEveryRecord({
      inFlightFireId: "fire-open",
      pendingBatch: marker,
      coalescedFirePending: true,
    });
    const at = CREATED_AT + INTERVAL + 10;
    const result = Trigger.Scheduler.step(record, { type: "cancel", at, detail: "owner asked" });

    expect(result.record.pendingBatch).toBeUndefined();
    expect(result.record.coalescedFirePending).toBe(false);
    // Cancel never deletes an already-recorded Fire.
    expect(result.record.inFlightFireId).toBe("fire-open");
    expect(result.record.lifecycle).toEqual({
      state: "ended",
      endReason: "cancelled",
      endedAt: at,
      endDetail: "owner asked",
    });
  });

  test("cancelling an event source requires a terminal cancellation summary", () => {
    const record = buildCommandRecord();
    expectRefusal(
      () => Trigger.Scheduler.step(record, { type: "cancel", at: CREATED_AT + 5 }),
      "requires terminal material",
    );

    const at = CREATED_AT + 5;
    const batch = buildTerminalBatch("cancelled", at, "cancelled by owner");
    const result = Trigger.Scheduler.step(record, {
      type: "cancel",
      at,
      terminalBatch: batch,
      fireMaterial: buildMaterial(batch, { id: "fire-cancel" }),
    });
    expect(result.record.inFlightFireId).toBe("fire-cancel");
    expect(result.record.lifecycle).toMatchObject({ state: "ended", endReason: "cancelled" });
  });

  test("cancelling an ended Trigger is an idempotent read", () => {
    const ended = buildOnceRecord({
      lifecycle: { state: "ended", endReason: "completed", endedAt: CREATED_AT + 1 },
    });
    const result = Trigger.Scheduler.step(ended, { type: "cancel", at: CREATED_AT + 2 });
    expect(result.record).toEqual(ended);
    expect(result.effects).toEqual([]);
  });
});

describe("Trigger scheduler — restore", () => {
  test("a future once alarm restores with a watermark advance and one arm", () => {
    const record = buildOnceRecord();
    const at = CREATED_AT + 1_000;
    const result = Trigger.Scheduler.step(record, { type: "restore", at });

    expect(result.record.lastObservedAt).toBe(at);
    expect(result.record.revision).toBe(record.revision + 1);
    expect(result.record.lifecycle).toEqual({ state: "armed" });
    expect(result.effects).toEqual([{ type: "arm", dueAt: CREATED_AT + 60_000 }]);
  });

  test("a due once alarm reserves one recovery Fire during restore", () => {
    const record = buildOnceRecord();
    const at = CREATED_AT + 90_000;
    const result = Trigger.Scheduler.step(record, {
      type: "restore",
      at,
      fireMaterial: buildAlarmMaterial(CREATED_AT + 60_000, at, {
        cause: "recovery",
        id: "fire-recovery",
      }),
    });
    expect(result.record.inFlightFireId).toBe("fire-recovery");
    expect(result.record.lifecycle).toMatchObject({ state: "ended", endReason: "completed" });
  });

  test("a paused once alarm installs no timer even when due", () => {
    const paused = buildOnceRecord({
      lifecycle: { state: "paused", pauseReason: "recovery_conflict", pausedAt: CREATED_AT },
    });
    const at = CREATED_AT + 90_000;
    const result = Trigger.Scheduler.step(paused, { type: "restore", at });
    expect(result.record.lifecycle.state).toBe("paused");
    expect(effectTypes(result.effects)).toEqual(["cancel_timer"]);
  });

  test("a recurring restore at or after expiry ends expired without firing", () => {
    const record = buildEveryRecord();
    const at = required(record.expiresAt, "expiresAt") + 1_000;
    const result = Trigger.Scheduler.step(record, { type: "restore", at });
    expect(result.record.fireCount).toBe(0);
    expect(result.record.lifecycle).toMatchObject({ state: "ended", endReason: "expired" });
  });

  test("a due recurring restore requires Fire material", () => {
    const record = buildEveryRecord();
    expectRefusal(
      () => Trigger.Scheduler.step(record, { type: "restore", at: CREATED_AT + INTERVAL + 1 }),
      "due recurring restore requires Fire material",
    );
  });

  test("a due once restore requires Fire material", () => {
    expectRefusal(
      () => Trigger.Scheduler.step(buildOnceRecord(), { type: "restore", at: CREATED_AT + 60_000 }),
      "due once restore requires Fire material",
    );
  });

  test("a paused recurring restore before expiry cancels its timer only", () => {
    const paused = buildEveryRecord({
      lifecycle: { state: "paused", pauseReason: "wake_budget", pausedAt: CREATED_AT },
    });
    const at = CREATED_AT + INTERVAL * 2;
    const result = Trigger.Scheduler.step(paused, { type: "restore", at });
    expect(result.record.lastObservedAt).toBe(at);
    expect(effectTypes(result.effects)).toEqual(["cancel_timer"]);
  });

  test("an armed event source restore arms its timeout and activates the source", () => {
    const record = buildCommandRecord();
    const at = CREATED_AT + 1_000;
    const result = Trigger.Scheduler.step(record, { type: "restore", at });
    expect(result.record.lastObservedAt).toBe(at);
    expect(result.effects).toEqual([
      { type: "arm", dueAt: required(record.expiresAt, "expiresAt") },
      { type: "activate_source" },
    ]);
  });

  test("a paused event source restore arms only its absolute timeout", () => {
    const paused = buildCommandRecord({
      lifecycle: { state: "paused", pauseReason: "source_unavailable", pausedAt: CREATED_AT },
    });
    const result = Trigger.Scheduler.step(paused, { type: "restore", at: CREATED_AT + 10 });
    expect(result.effects).toEqual([
      { type: "arm", dueAt: required(paused.expiresAt, "expiresAt") },
    ]);
  });

  test("a persistent command restore arms no deadline", () => {
    const persistent = buildCommandRecord({
      source: { kind: "event.command", command: "tail -f x", persistent: true },
      expiresAt: undefined,
    });
    const result = Trigger.Scheduler.step(persistent, { type: "restore", at: CREATED_AT + 10 });
    expect(effectTypes(result.effects)).toEqual(["activate_source"]);
  });

  test("a finite source restore at expiry ends source_timeout without opening a handle", () => {
    const record = buildCommandRecord();
    const at = required(record.expiresAt, "expiresAt");
    const batch = buildTerminalBatch("source_timeout", at, "source timed out");
    const result = Trigger.Scheduler.step(record, {
      type: "restore",
      at,
      fireMaterial: buildMaterial(batch, { id: "fire-timeout" }),
    });
    expect(result.record.inFlightFireId).toBe("fire-timeout");
    expect(result.record.lifecycle).toMatchObject({
      state: "ended",
      endReason: "source_timeout",
    });
    expect(effectTypes(result.effects)).not.toContain("activate_source");
  });

  test("a finite source restore at expiry without material is refused", () => {
    const record = buildCommandRecord();
    expectRefusal(
      () =>
        Trigger.Scheduler.step(record, {
          type: "restore",
          at: required(record.expiresAt, "expiresAt"),
        }),
      "finite source restore requires timeout material",
    );
  });

  test("an ended Trigger is never resurrected by restore", () => {
    const ended = buildCommandRecord({
      lifecycle: { state: "ended", endReason: "source_exited", endedAt: CREATED_AT + 1 },
    });
    const result = Trigger.Scheduler.step(ended, { type: "restore", at: CREATED_AT + 10_000 });
    expect(result.record).toEqual(ended);
    expect(result.effects).toEqual([]);
  });
});

describe("Trigger scheduler — delivery acknowledgement", () => {
  const admission = (fireId: string, at: number): Trigger.FireAdmission => ({
    fireId,
    sessionId: "session-owner",
    messageId: `trigger-fire:${fireId}`,
    payloadDigest: canonicalDigest("trigger payload"),
    admittedAt: at,
  });

  test("an ack with no pending work clears the gate", () => {
    const record = buildCommandRecord({ inFlightFireId: "fire-open" });
    const at = CREATED_AT + 30;
    const result = Trigger.Scheduler.step(record, {
      type: "delivery_acknowledged",
      fireId: "fire-open",
      at,
      admission: admission("fire-open", at),
    });
    expect(result.record.inFlightFireId).toBeUndefined();
    expect(result.record.revision).toBe(record.revision + 1);
    expect(result.effects).toEqual([]);
  });

  test("an ack with pending work drains exactly one fingerprint-pinned replacement", () => {
    const pending = buildBatch({
      items: [{ kind: "line", text: "queued", at: CREATED_AT + 2 }],
      firstAt: CREATED_AT + 2,
      lastAt: CREATED_AT + 2,
    });
    const record = buildCommandRecord({
      inFlightFireId: "fire-open",
      pendingBatch: pending,
      coalescedFirePending: true,
    });
    const at = CREATED_AT + 30;
    const result = Trigger.Scheduler.step(record, {
      type: "delivery_acknowledged",
      fireId: "fire-open",
      at,
      admission: admission("fire-open", at),
      nextReservation: {
        pendingFingerprint: pending.fingerprint,
        reservation: buildReservation({
          id: "fire-next",
          cause: "coalesced",
          sourceItems: pending.items,
          firedAt: CREATED_AT + 2,
        }),
      },
    });

    expect(result.record.inFlightFireId).toBe("fire-next");
    expect(result.record.pendingBatch).toBeUndefined();
    expect(result.record.coalescedFirePending).toBe(false);
    expect(result.record.fireCount).toBe(1);
    // Release plus reservation are two sequential parent facts.
    expect(result.record.revision).toBe(record.revision + 2);
    expect(result.effects).toEqual([{ type: "reserve_fire", fireId: "fire-next" }]);
  });

  test("a stale pending fingerprint refuses the ack rather than dropping the batch", () => {
    const pending = buildBatch();
    const record = buildCommandRecord({
      inFlightFireId: "fire-open",
      pendingBatch: pending,
      coalescedFirePending: true,
    });
    const at = CREATED_AT + 30;
    expectRefusal(
      () =>
        Trigger.Scheduler.step(record, {
          type: "delivery_acknowledged",
          fireId: "fire-open",
          at,
          admission: admission("fire-open", at),
          nextReservation: {
            pendingFingerprint: canonicalDigest("stale"),
            reservation: buildReservation({ id: "fire-next", cause: "coalesced" }),
          },
        }),
      "fingerprint mismatch",
    );

    expectRefusal(
      () =>
        Trigger.Scheduler.step(record, {
          type: "delivery_acknowledged",
          fireId: "fire-open",
          at,
          admission: admission("fire-open", at),
        }),
      "fingerprint mismatch",
    );
  });

  test("a reservation without pending work is refused", () => {
    const record = buildCommandRecord({ inFlightFireId: "fire-open" });
    const at = CREATED_AT + 30;
    expectRefusal(
      () =>
        Trigger.Scheduler.step(record, {
          type: "delivery_acknowledged",
          fireId: "fire-open",
          at,
          admission: admission("fire-open", at),
          nextReservation: {
            pendingFingerprint: buildBatch().fingerprint,
            reservation: buildReservation({ id: "fire-next" }),
          },
        }),
      "without pending work",
    );
  });

  test("an ack that does not match the in-flight Fire is refused", () => {
    const record = buildCommandRecord({ inFlightFireId: "fire-open" });
    const at = CREATED_AT + 30;
    expectRefusal(
      () =>
        Trigger.Scheduler.step(record, {
          type: "delivery_acknowledged",
          fireId: "fire-other",
          at,
          admission: admission("fire-other", at),
        }),
      "does not match in-flight Fire",
    );
  });

  test("an ended parent still drains its terminal pending Fire", () => {
    const terminal = buildTerminalBatch("source_exited", CREATED_AT + 3);
    const record = buildCommandRecord({
      lifecycle: { state: "ended", endReason: "source_exited", endedAt: CREATED_AT + 3 },
      inFlightFireId: "fire-open",
      pendingBatch: terminal,
      coalescedFirePending: true,
    });
    const at = CREATED_AT + 40;
    const result = Trigger.Scheduler.step(record, {
      type: "delivery_acknowledged",
      fireId: "fire-open",
      at,
      admission: admission("fire-open", at),
      nextReservation: {
        pendingFingerprint: terminal.fingerprint,
        reservation: buildReservation({
          id: "fire-terminal",
          cause: "source_summary",
          terminalReason: "source_exited",
          sourceItems: terminal.items,
          firedAt: CREATED_AT + 3,
        }),
      },
    });
    expect(result.record.inFlightFireId).toBe("fire-terminal");
    expect(result.record.lifecycle).toMatchObject({ state: "ended" });
  });
});

describe("Trigger scheduler — bounded coalescing under pressure", () => {
  test("a merge past the rendered budget trims from the tail and counts overflow", () => {
    const text = "y".repeat(Trigger.Constants.MAX_EVENT_TEXT_CHARS);
    const budget = Trigger.Constants.NOTIFIER_MAX_CHARS - Trigger.Constants.QUEUE_OVERHEAD_CHARS;
    const fits = Math.floor(budget / ("line".length + text.length + 4));
    const existing = buildBatch({
      items: Array.from({ length: fits }, () => ({
        kind: "line" as const,
        text,
        at: CREATED_AT + 1,
      })),
      firstAt: CREATED_AT + 1,
      lastAt: CREATED_AT + 1,
    });
    const record = buildCommandRecord({
      inFlightFireId: "fire-open",
      pendingBatch: existing,
      coalescedFirePending: true,
    });
    const incoming = buildBatch({
      items: [{ kind: "line", text, at: CREATED_AT + 2 }],
      firstAt: CREATED_AT + 2,
      lastAt: CREATED_AT + 2,
    });

    const result = Trigger.Scheduler.step(record, {
      type: "source_observation",
      batch: incoming,
      at: CREATED_AT + 2,
      fireMaterial: buildMaterial(incoming, { id: "fire-x" }),
    });

    // The batch stays inside the durable budget and discloses what it dropped.
    expect(result.record.pendingBatch?.items.length).toBe(fits);
    expect(result.record.pendingBatch?.overflowCount).toBe(1);
    expect(Trigger.PendingBatch.safeParse(result.record.pendingBatch).success).toBe(true);
  });

  test("ending a Trigger discards its ordinary pending lines", () => {
    const pending = buildBatch({
      items: [{ kind: "line", text: "ordinary", at: CREATED_AT + 1 }],
      firstAt: CREATED_AT + 1,
      lastAt: CREATED_AT + 1,
    });
    const record = buildEveryRecord({
      inFlightFireId: "fire-open",
      pendingBatch: pending,
      coalescedFirePending: true,
    });
    const at = required(record.expiresAt, "expiresAt");
    const result = Trigger.Scheduler.step(record, {
      type: "timer_due",
      at,
      fireMaterial: buildAlarmMaterial(required(record.nextFireAt, "nextFireAt"), at),
    });

    expect(result.record.lifecycle).toMatchObject({ state: "ended", endReason: "expired" });
    expect(result.record.pendingBatch).toBeUndefined();
    expect(result.record.coalescedFirePending).toBe(false);
    // Ending never clears the unacked Fire itself.
    expect(result.record.inFlightFireId).toBe("fire-open");
  });

  test("a corrupt row mixing a schedule marker and source items refuses the merge", () => {
    const sourceBatch = buildBatch();
    const corrupt = buildEveryRecord({
      inFlightFireId: "fire-open",
      pendingBatch: sourceBatch,
      coalescedFirePending: true,
    });
    const at = CREATED_AT + INTERVAL;

    let raised: unknown;
    try {
      Trigger.Scheduler.step(corrupt, {
        type: "timer_due",
        at,
        fireMaterial: buildAlarmMaterial(at, at),
      });
    } catch (error) {
      raised = error;
    }
    expect(Trigger.StoreError.isInstance(raised)).toBe(true);
    if (!Trigger.StoreError.isInstance(raised)) throw new Error("expected a typed refusal");
    expect(raised.data.code).toBe("corrupt");
  });
});

describe("Trigger scheduler — global guards", () => {
  test("an exhausted revision refuses every mutation", () => {
    const record = buildOnceRecord({ revision: Trigger.Constants.MAX_COUNTER });
    expectRefusal(
      () => Trigger.Scheduler.step(record, { type: "restore", at: CREATED_AT + 1 }),
      "revision is exhausted",
    );
  });

  test("a malformed record or input is rejected before any fold runs", () => {
    expect(() =>
      Trigger.Scheduler.step({ ...buildOnceRecord(), revision: 0 } as Trigger.Record, {
        type: "restore",
        at: CREATED_AT,
      }),
    ).toThrow();
    expect(() =>
      Trigger.Scheduler.step(buildOnceRecord(), {
        type: "unknown",
        at: CREATED_AT,
      } as unknown as Trigger.SchedulerInput),
    ).toThrow();
  });
});
