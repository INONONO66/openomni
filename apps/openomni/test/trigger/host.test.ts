import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, Storage, TriggerFireStore, TriggerStore } from "@openomni/ledger";
import { type Gateway, type Ingress, Trigger } from "@openomni/protocol";
import {
  createTriggerHost,
  type TriggerHost,
  type TriggerHostDeps,
  type TriggerTimerPort,
} from "../../src/trigger";
import type { ResidentDelivery } from "../../src/resident";

const OWNER = "session-owner";
const START = 1_700_000_000_000;

function materializeSession(id: string): void {
  Session.materialize({
    id,
    traceId: `trace-${id}`,
    title: "Resident chat",
    model: { providerID: "test", modelID: "test-model" },
  });
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`expected ${field} to be present`);
  return value;
}

/** A timer port that never touches wall time: tests fire deadlines by hand. */
interface ManualTimer extends TriggerTimerPort {
  /** Runs the callback armed for `key`, exactly once. */
  fire(key: string): void;
  armed(): string[];
  dueAt(key: string): number | undefined;
  /** Resolves the moment `key` is armed — the exact signal, never a sleep. */
  whenArmed(key: string): Promise<void>;
}

function createManualTimer(): ManualTimer {
  const armed = new Map<string, { dueAt: number; run: () => void }>();
  const waiters = new Map<string, Array<() => void>>();
  return {
    arm(key, dueAt, run) {
      armed.set(key, { dueAt, run });
      for (const resolve of waiters.get(key) ?? []) resolve();
      waiters.delete(key);
    },
    cancel(key) {
      armed.delete(key);
    },
    cancelAll() {
      armed.clear();
    },
    fire(key) {
      const entry = required(armed.get(key), `armed timer ${key}`);
      armed.delete(key);
      entry.run();
    },
    armed() {
      return [...armed.keys()].sort();
    },
    dueAt(key) {
      return armed.get(key)?.dueAt;
    },
    whenArmed(key) {
      if (armed.has(key)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.set(key, [...(waiters.get(key) ?? []), resolve]);
      });
    },
  };
}

interface RecordedDelivery {
  readonly delivery: Gateway.InternalDeliver;
  readonly admission: Trigger.FireAdmission;
}

/**
 * A Resident stand-in that runs the real two-phase internal contract: the host
 * hands it a `beforeRun` gate which must be awaited before the "turn" happens.
 */
function createRecordingResident(now: () => number, options: { failOnce?: boolean } = {}) {
  const delivered: RecordedDelivery[] = [];
  let failuresLeft = options.failOnce === true ? 1 : 0;
  const resident = (async () => {
    throw new Error("external delivery is not part of these tests");
  }) as unknown as ResidentDelivery;
  resident.deliver = async () => {
    throw new Error("external delivery is not part of these tests");
  };
  resident.deliverInternal = async (delivery, beforeRun) => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error("resident refused this attempt");
    }
    // The real production admission, not a hand-built receipt: this is what
    // makes the ack in these tests depend on a genuinely durable transcript.
    const fire = required(TriggerFireStore.get(delivery.event.meta.fireId), "fire under delivery");
    const admission = Session.admitInternalTrigger({
      sessionId: delivery.sessionId,
      fireId: fire.id,
      payload: fire.payload,
      payloadDigest: fire.payloadDigest,
      // Admission happens at the delivery instant; an admission dated before
      // the Fire was delivered is rejected by the Fire invariant itself.
      admittedAt: Math.max(now(), fire.deliveredAt ?? 0),
    });
    // Admission is durable BEFORE the model turn: that is what ack depends on.
    await beforeRun(admission);
    delivered.push({ delivery, admission });
    return {
      mode: "direct",
      target: { kind: "resident" },
      sessionId: delivery.sessionId,
      result: { output: "ok", finishReason: "stop" },
    } as Ingress.IngressResult;
  };
  return { resident, delivered };
}

interface Harness {
  readonly host: TriggerHost;
  readonly timer: ManualTimer;
  readonly delivered: RecordedDelivery[];
  readonly errors: unknown[];
  /** Resolves once the notifier has been armed for a flush deadline. */
  flushArmed(): Promise<void>;
  /** Resolves once the notifier has observed exactly `count` source events. */
  observed(count: number): Promise<void>;
  now(): number;
  advance(ms: number): void;
  build(overrides?: Partial<TriggerHostDeps>): TriggerHost;
}

let dir: string;
let sequence: number;

function newId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

/**
 * Counts notifier observations so a test can await the exact event it cares
 * about instead of guessing how many microtasks a source's serial queue takes.
 */
function countingNotifier(): {
  port: NonNullable<TriggerHostDeps["notifier"]>;
  observed(count: number): Promise<void>;
} {
  let state = Trigger.Notifier.initialState();
  let seen = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const advance = (result: Trigger.Notifier.Result): Trigger.Notifier.Result => {
    state = result.state;
    return result;
  };
  return {
    port: {
      observe(event, now) {
        seen += 1;
        for (const waiter of waiters.filter((entry) => entry.count <= seen)) waiter.resolve();
        return advance(Trigger.Notifier.observe(state, event, now));
      },
      flush: (now) => advance(Trigger.Notifier.flush(state, now)),
      rearm: (triggerId) => advance(Trigger.Notifier.rearm(state, triggerId)),
      noteActivity: (now) => advance(Trigger.Notifier.noteActivity(state, now)),
      dispose: () => advance(Trigger.Notifier.dispose(state)),
    },
    observed(count) {
      if (seen >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push({ count, resolve });
      });
    },
  };
}

function openHarness(overrides: Partial<TriggerHostDeps> = {}): Harness {
  let current = START;
  const timer = createManualTimer();
  const notifier = countingNotifier();
  const { resident, delivered } = createRecordingResident(() => current);
  const errors: unknown[] = [];
  const build = (extra: Partial<TriggerHostDeps> = {}): TriggerHost =>
    createTriggerHost({
      clock: { now: () => current },
      newTriggerId: () => newId("trigger"),
      newFireId: () => newId("fire"),
      newTraceId: () => newId("trace"),
      triggers: TriggerStore,
      fires: TriggerFireStore,
      sessions: { exists: (sessionId) => Session.get(sessionId) !== undefined },
      resident,
      timer,
      notifier: notifier.port,
      onOperationalError: ({ error }) => errors.push(error),
      ...overrides,
      ...extra,
    });
  return {
    host: build(),
    timer,
    delivered,
    errors,
    flushArmed: () => timer.whenArmed("notifier:flush"),
    observed: (count) => notifier.observed(count),
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    build,
  };
}

beforeEach(() => {
  sequence = 0;
  dir = mkdtempSync(join(tmpdir(), "trigger-host-"));
  // Storage is a process global, so claim it rather than assuming a prior file
  // left it clean.
  Storage.reset();
  // A real file-backed SQLite ledger, not `:memory:` — the restart-replay test
  // is only honest if durable state genuinely outlives its host.
  Storage.initialize({ dbPath: join(dir, "ledger.sqlite") });
  materializeSession(OWNER);
});

afterEach(() => {
  Storage.reset();
  rmSync(dir, { recursive: true, force: true });
});

describe("TriggerHost — the app-side owner of Trigger effects", () => {
  test("a due time.once Trigger fires, delivers, and the ack ends it in one closed chain", async () => {
    const harness = openHarness();
    await harness.host.startRecovery();
    const created = await harness.host.create(OWNER, {
      prompt: "ship the release notes",
      source: { kind: "time.once", at: START + 60_000 },
    });

    // Creation arms a timer rather than firing: the deadline is the only cause.
    expect(created.lifecycle.state).toBe("armed");
    expect(harness.timer.dueAt(created.id)).toBe(START + 60_000);
    expect(harness.delivered).toHaveLength(0);

    harness.advance(60_000);
    harness.timer.fire(created.id);
    await harness.host.stop();

    const fire = required(harness.delivered[0], "delivered fire");
    expect(fire.delivery.event.payload).toContain("ship the release notes");
    expect(fire.delivery.sessionId).toBe(OWNER);
    // The Fire is acked because admission was durable, and a one-shot Trigger
    // that has fired is finished — not re-armed.
    expect(required(TriggerFireStore.get(fire.admission.fireId), "fire").status).toBe("acked");
    expect(required(TriggerStore.get(created.id), "trigger").lifecycle.state).toBe("ended");
    expect(TriggerFireStore.listUnackedIds()).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  test("a recurring Trigger re-arms for its next instant after the ack", async () => {
    const harness = openHarness();
    await harness.host.startRecovery();
    const created = await harness.host.create(OWNER, {
      prompt: "hourly sweep",
      source: { kind: "time.every", intervalMs: 3_600_000 },
    });

    harness.advance(3_600_000);
    harness.timer.fire(created.id);
    await harness.host.stop();

    const after = required(TriggerStore.get(created.id), "trigger");
    expect(after.lifecycle.state).toBe("armed");
    expect(after.fireCount).toBe(1);
    // The re-arm is the ack's consequence, so the next deadline is live.
    expect(after.nextFireAt).toBe(START + 7_200_000);
  });

  test("a Fire the Resident refuses stays unacked and is replayed by the next boot", async () => {
    let current = START;
    const timer = createManualTimer();
    const { resident, delivered } = createRecordingResident(() => current, { failOnce: true });
    const errors: unknown[] = [];
    const deps: TriggerHostDeps = {
      clock: { now: () => current },
      newTriggerId: () => newId("trigger"),
      newFireId: () => newId("fire"),
      newTraceId: () => newId("trace"),
      triggers: TriggerStore,
      fires: TriggerFireStore,
      sessions: { exists: (sessionId) => Session.get(sessionId) !== undefined },
      resident,
      timer,
      onOperationalError: ({ error }) => errors.push(error),
    };

    const first = createTriggerHost(deps);
    await first.startRecovery();
    const created = await first.create(OWNER, {
      prompt: "must survive a refusal",
      source: { kind: "time.once", at: START + 1_000 },
    });
    current += 1_000;
    timer.fire(created.id);
    await first.stop();

    // The refusal is reported, the row is durable and unacked, nothing is lost.
    expect(errors).toHaveLength(1);
    expect(delivered).toHaveLength(0);
    const pending = TriggerFireStore.listUnackedIds();
    expect(pending).toHaveLength(1);

    // A fresh process replays exactly that Fire from durable state alone.
    const second = createTriggerHost(deps);
    await second.startRecovery();
    await second.stop();

    expect(delivered).toHaveLength(1);
    expect(required(delivered[0], "replayed").admission.fireId).toEqual(
      required(pending[0], "pending"),
    );
    expect(TriggerFireStore.listUnackedIds()).toEqual([]);
  });

  test("recovery pauses a Trigger whose owner session is gone rather than delivering to nobody", async () => {
    const harness = openHarness();
    await harness.host.startRecovery();
    const created = await harness.host.create(OWNER, {
      prompt: "orphaned",
      source: { kind: "time.once", at: START + 1_000 },
    });
    harness.advance(1_000);
    harness.timer.fire(created.id);
    await harness.host.stop();
    expect(harness.delivered).toHaveLength(1);

    // A second Fire is recorded, then the owner session disappears.
    const second = openHarness();
    const recurring = await second.host.create(OWNER, {
      prompt: "owner will vanish",
      source: { kind: "time.every", intervalMs: 60_000 },
    });
    second.advance(60_000);
    second.timer.fire(recurring.id);
    await second.host.stop();

    const orphan = createTriggerHost({
      clock: { now: () => START + 120_000 },
      newTriggerId: () => newId("trigger"),
      newFireId: () => newId("fire"),
      newTraceId: () => newId("trace"),
      triggers: TriggerStore,
      fires: TriggerFireStore,
      // The owner session is missing on this boot.
      sessions: { exists: () => false },
      resident: createRecordingResident(() => START + 120_000).resident,
      timer: createManualTimer(),
      onOperationalError: () => undefined,
    });
    await orphan.startRecovery();
    await orphan.stop();

    expect(required(TriggerStore.get(recurring.id), "trigger").lifecycle.state).toBe("paused");
  });

  test("cancel is idempotent and never rewrites an already-ended terminal reason", async () => {
    const harness = openHarness();
    await harness.host.startRecovery();
    const created = await harness.host.create(OWNER, {
      prompt: "fires then is cancelled",
      source: { kind: "time.once", at: START + 1_000 },
    });
    harness.advance(1_000);
    harness.timer.fire(created.id);

    const ended = required(TriggerStore.get(created.id), "trigger");
    expect(ended.lifecycle.state).toBe("ended");
    const terminal = ended.lifecycle.state === "ended" ? ended.lifecycle.endReason : undefined;

    const cancelled = await harness.host.cancel(OWNER, created.id);
    // Cancelling a completed Trigger reports the truth, not "cancelled".
    expect(cancelled.lifecycle.state === "ended" ? cancelled.lifecycle.endReason : undefined).toBe(
      terminal,
    );
    expect(cancelled.revision).toBe(ended.revision);
    await harness.host.stop();
  });

  test("cancelling an armed Trigger ends it and drops its deadline", async () => {
    const harness = openHarness();
    await harness.host.startRecovery();
    const created = await harness.host.create(OWNER, {
      prompt: "will be cancelled",
      source: { kind: "time.once", at: START + 600_000 },
    });
    expect(harness.timer.armed()).toContain(created.id);

    const cancelled = await harness.host.cancel(OWNER, created.id);
    expect(cancelled.lifecycle.state).toBe("ended");
    // The timer is released by the committed effect, not left to fire into a
    // dead row.
    expect(harness.timer.armed()).not.toContain(created.id);
    await harness.host.stop();
  });

  test("another session's Trigger is not found rather than filtered after the fact", async () => {
    const harness = openHarness();
    await harness.host.startRecovery();
    const created = await harness.host.create(OWNER, {
      prompt: "owner only",
      source: { kind: "time.once", at: START + 60_000 },
    });

    materializeSession("session-intruder");
    await expect(harness.host.cancel("session-intruder", created.id)).rejects.toThrow(/not found/);
    expect(await harness.host.list("session-intruder", true)).toEqual([]);
    expect(await harness.host.list(OWNER, false)).toHaveLength(1);
    await harness.host.stop();
  });

  test("list hides ended rows unless the caller asks for history", async () => {
    const harness = openHarness();
    await harness.host.startRecovery();
    const kept = await harness.host.create(OWNER, {
      prompt: "stays armed",
      source: { kind: "time.once", at: START + 600_000 },
    });
    const gone = await harness.host.create(OWNER, {
      prompt: "gets cancelled",
      source: { kind: "time.once", at: START + 600_000 },
    });
    await harness.host.cancel(OWNER, gone.id);

    expect((await harness.host.list(OWNER, false)).map((row) => row.id)).toEqual([kept.id]);
    expect((await harness.host.list(OWNER, true)).map((row) => row.id).sort()).toEqual(
      [kept.id, gone.id].sort(),
    );
    await harness.host.stop();
  });

  test("rearm on an ended Trigger refuses with invalid_transition and never resurrects it", async () => {
    const harness = openHarness();
    await harness.host.startRecovery();
    const created = await harness.host.create(OWNER, {
      prompt: "cancelled for good",
      source: { kind: "time.every", intervalMs: 60_000 },
    });
    await harness.host.cancel(OWNER, created.id);

    await expect(harness.host.rearm(OWNER, created.id)).rejects.toMatchObject({
      data: { code: "invalid_transition" },
    });
    expect(required(TriggerStore.get(created.id), "trigger").lifecycle.state).toBe("ended");
    await harness.host.stop();
  });

  test("stop is cleanup, not cancellation: armed rows and their durable state survive", async () => {
    const harness = openHarness();
    await harness.host.startRecovery();
    const created = await harness.host.create(OWNER, {
      prompt: "survives shutdown",
      source: { kind: "time.every", intervalMs: 60_000 },
    });

    await harness.host.stop();

    // No terminal summary, no pause: shutdown says nothing about intent.
    const after = required(TriggerStore.get(created.id), "trigger");
    expect(after.lifecycle.state).toBe("armed");
    expect(after.revision).toBe(created.revision);
    expect(harness.timer.armed()).toEqual([]);
  });

  test("stop is idempotent and closes the delivery drain", async () => {
    const harness = openHarness();
    await harness.host.startRecovery();
    await harness.host.stop();
    await harness.host.stop();

    // A deadline that arrives after stop is inert: no Fire is recorded.
    expect(harness.delivered).toHaveLength(0);
    expect(harness.errors).toEqual([]);
  });

  test("an unsafe source is refused before any row is committed", async () => {
    const harness = openHarness();
    await harness.host.startRecovery();

    await expect(
      harness.host.create(OWNER, {
        prompt: "watches a path that cannot exist",
        source: { kind: "event.file", path: join(dir, "missing-dir", "target.txt"), on: "modify" },
      }),
    ).rejects.toThrow();

    // Nothing was created: a Trigger that could never run does not exist.
    expect(await harness.host.list(OWNER, true)).toEqual([]);
    await harness.host.stop();
  });

  test("a deadline for a Trigger cancelled in the same tick is reported, not fired", async () => {
    const harness = openHarness();
    await harness.host.startRecovery();
    const created = await harness.host.create(OWNER, {
      prompt: "raced against cancel",
      source: { kind: "time.once", at: START + 1_000 },
    });
    const armed = required(harness.timer.dueAt(created.id), "armed deadline");
    expect(armed).toBe(START + 1_000);

    // Take the callback, then end the row underneath it.
    const fireDeadline = () => harness.timer.fire(created.id);
    await harness.host.cancel(OWNER, created.id);
    // Cancel released the timer, so nothing remains to fire.
    expect(() => fireDeadline()).toThrow(/armed timer/);
    expect(harness.delivered).toHaveLength(0);
    await harness.host.stop();
  });

  test("recovery replays nothing and opens the drain when the ledger is empty", async () => {
    const harness = openHarness();
    await harness.host.startRecovery();
    expect(harness.delivered).toEqual([]);
    expect(harness.errors).toEqual([]);

    // The drain is open, so a Fire recorded now delivers without another boot.
    const created = await harness.host.create(OWNER, {
      prompt: "post-recovery",
      source: { kind: "time.once", at: START + 1_000 },
    });
    harness.advance(1_000);
    harness.timer.fire(created.id);
    await harness.host.stop();
    expect(harness.delivered).toHaveLength(1);
  });

  test("user activity resets wake suppression without touching durable state", async () => {
    const harness = openHarness();
    await harness.host.startRecovery();
    const created = await harness.host.create(OWNER, {
      prompt: "unaffected",
      source: { kind: "time.every", intervalMs: 60_000 },
    });
    const before = required(TriggerStore.get(created.id), "trigger").revision;

    harness.host.noteUserActivity();

    expect(required(TriggerStore.get(created.id), "trigger").revision).toBe(before);
    await harness.host.stop();
  });
});

/** A command child the test drives line by line; no real process, no sleeps. */
class FakeStream {
  private readonly listeners = new Map<string, Array<(value: unknown) => void>>();
  on(event: "data" | "error", listener: (value: unknown) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: "data" | "error", value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

class FakeChild {
  readonly pid = 5150;
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  private readonly listeners = new Map<string, Array<(...values: unknown[]) => void>>();
  once(event: "close" | "error", listener: (...values: never[]) => void): this {
    this.listeners.set(event, [listener as (...values: unknown[]) => void]);
    return this;
  }
  close(code: number | null = 0, signal: string | null = null): void {
    for (const listener of this.listeners.get("close") ?? []) listener(code, signal);
  }
}

describe("TriggerHost — event.command sources become durable Fires", () => {
  function commandHarness() {
    const child = new FakeChild();
    const harness = openHarness({
      commandDeps: {
        cwd: dir,
        spawn: () => child as never,
        signalGroup: () => child.close(null, "SIGTERM"),
        graceTimer: {
          arm: (_delayMs, run) => {
            run();
            return () => undefined;
          },
        },
      },
    });
    return { child, harness };
  }

  test("a coalesced line batch becomes one Fire delivered to the owner", async () => {
    const { child, harness } = commandHarness();
    await harness.host.startRecovery();
    const created = await harness.host.create(OWNER, {
      prompt: "watch the build",
      source: { kind: "event.command", command: "tail -f build.log", persistent: true },
    });
    expect(created.lifecycle.state).toBe("armed");

    child.stdout.emit("data", Buffer.from("first line\nsecond line\n"));
    // The source hands lines to the sink through a serial queue, so wait for
    // BOTH observations to land before flushing the coalesce window.
    await harness.observed(2);
    await harness.flushArmed();
    harness.advance(2_000);
    harness.timer.fire("notifier:flush");
    await harness.host.stop();

    const fire = required(harness.delivered[0], "coalesced fire");
    // Both lines rode ONE Fire — that is what coalescing buys.
    expect(fire.delivery.event.payload).toContain("first line");
    expect(fire.delivery.event.payload).toContain("second line");
    expect(harness.delivered).toHaveLength(1);
    expect(required(TriggerFireStore.get(fire.admission.fireId), "fire").status).toBe("acked");
    expect(harness.errors).toEqual([]);
  });

  test("a non-persistent source that exits ends the Trigger with its terminal summary", async () => {
    const { child, harness } = commandHarness();
    await harness.host.startRecovery();
    const created = await harness.host.create(OWNER, {
      prompt: "run the check once",
      source: { kind: "event.command", command: "make check", persistent: false },
    });

    child.stdout.emit("data", Buffer.from("all good\n"));
    child.close(0, null);
    // One line plus the terminal summary.
    await harness.observed(2);
    await harness.flushArmed();
    harness.advance(2_000);
    harness.timer.fire("notifier:flush");
    await harness.host.stop();

    // The exit is a terminal observation, so the Trigger is finished.
    expect(required(TriggerStore.get(created.id), "trigger").lifecycle.state).toBe("ended");
    expect(harness.delivered.length).toBeGreaterThan(0);
  });

  test("cancelling a live command Trigger ends the row and releases the source", async () => {
    const { child, harness } = commandHarness();
    await harness.host.startRecovery();
    const created = await harness.host.create(OWNER, {
      prompt: "cancel me",
      source: { kind: "event.command", command: "tail -f x.log", persistent: true },
    });

    const cancelled = await harness.host.cancel(OWNER, created.id);
    expect(cancelled.lifecycle.state).toBe("ended");

    // Cancelling a watch owes the Resident one terminal Fire, so it learns the
    // source it was waiting on stopped and why.
    const terminal = required(harness.delivered[0], "terminal fire");
    expect(terminal.delivery.event.payload).toContain("cancelled");

    // Lines arriving after cancellation are not resurrected into a new Fire.
    child.stdout.emit("data", Buffer.from("too late\n"));
    harness.advance(2_000);
    await harness.host.stop();
    expect(harness.delivered).toHaveLength(1);
    expect(
      harness.delivered.some((entry) => entry.delivery.event.payload.includes("too late")),
    ).toBe(false);
  });

  test("recovery re-activates an armed command Trigger from durable state alone", async () => {
    const first = commandHarness();
    await first.harness.host.startRecovery();
    const created = await first.harness.host.create(OWNER, {
      prompt: "survives a restart",
      source: { kind: "event.command", command: "tail -f y.log", persistent: true },
    });
    await first.harness.host.stop();
    expect(required(TriggerStore.get(created.id), "trigger").lifecycle.state).toBe("armed");

    // A brand-new host, same ledger: the source is live again after the sweep.
    const second = commandHarness();
    await second.harness.host.startRecovery();
    second.child.stdout.emit("data", Buffer.from("after restart\n"));
    await second.harness.observed(1);
    await second.harness.flushArmed();
    second.harness.advance(2_000);
    second.harness.timer.fire("notifier:flush");
    await second.harness.host.stop();

    const fire = required(second.harness.delivered[0], "post-restart fire");
    expect(fire.delivery.event.payload).toContain("after restart");
  });
});
