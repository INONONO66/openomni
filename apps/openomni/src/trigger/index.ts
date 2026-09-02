import { Trigger } from "@openomni/protocol";
import type { TriggerToolPort } from "../tools/triggers";
import {
  createTriggerDelivery,
  type TriggerDelivery,
  type TriggerFireStorePort,
  type TriggerRecordStorePort,
  type InternalRoutePort,
} from "./delivery";
import { buildFireMaterial, sanitizeSourceText } from "./notifier";
import {
  createTriggerTimerPort,
  triggerLogicalNow,
  type TriggerClock,
  type TriggerTimerPort,
} from "./scheduler";
import {
  preflightCommandSource,
  startCommandSource,
  type CommandSourceDeps,
  type CommandSourceHandle,
  type EventSourceSink,
} from "./sources/command";
import {
  preflightFileSource,
  recoverFileSource,
  startFileSource,
  type FileSourceDeps,
  type FileSourceHandle,
} from "./sources/file";

export type { TriggerTimerPort } from "./scheduler";

/** The durable store surface the host drives; both stores are ledger-backed. */
interface TriggerHostStores extends TriggerRecordStorePort {
  create(input: Trigger.Create, traceId: string): Trigger.Record;
  list(filter?: {
    ownerSessionId?: string;
    states?: readonly Trigger.LifecycleState[];
  }): Trigger.Record[];
  listActiveIds(): string[];
  transition(request: {
    triggerId: string;
    expectedRevision: number;
    input: Exclude<Trigger.SchedulerInput, { type: "delivery_acknowledged" }>;
    traceId: string;
  }): {
    trigger: Trigger.Record;
    fire?: Trigger.Fire;
    effects: readonly Trigger.SchedulerEffect[];
  };
}

interface TriggerHostFireStores extends TriggerFireStorePort {
  list(filter?: { triggerId?: string; statuses?: readonly Trigger.FireStatus[] }): Trigger.Fire[];
  listUnackedIds(): string[];
}

/** Recovery asks only whether an owner session still exists. */
interface TriggerSessionPort {
  exists(sessionId: string): boolean;
}

/** The Resident consumer of internal Fire deliveries. */
interface TriggerResidentPort {
  deliverInternal: Parameters<typeof createTriggerDelivery>[0]["resident"]["deliverInternal"];
}

interface TriggerNotifierPort {
  observe(event: Trigger.Notifier.Event, now: number): Trigger.Notifier.Result;
  flush(now: number): Trigger.Notifier.Result;
  rearm(triggerId: string): Trigger.Notifier.Result;
  noteActivity(now: number): Trigger.Notifier.Result;
  dispose(): Trigger.Notifier.Result;
}

export interface TriggerHostDeps {
  readonly clock: TriggerClock;
  readonly newTriggerId: () => string;
  readonly newFireId: () => string;
  readonly newTraceId: () => string;
  readonly triggers: TriggerHostStores;
  readonly fires: TriggerHostFireStores;
  readonly sessions: TriggerSessionPort;
  readonly resident: TriggerResidentPort;
  readonly route?: InternalRoutePort;
  readonly timer?: TriggerTimerPort;
  readonly notifier?: TriggerNotifierPort;
  readonly commandDeps?: Omit<CommandSourceDeps, "clock">;
  readonly fileDeps?: Omit<FileSourceDeps, "clock">;
  readonly onOperationalError?: (facts: {
    readonly triggerId?: string;
    readonly fireId?: string;
    readonly error: unknown;
  }) => void;
}

export interface TriggerHost extends TriggerToolPort {
  /** Replays durable state, then opens the delivery drain. */
  startRecovery(): Promise<void>;
  /**
   * One ordinary user admission resets notifier wake suppression. Unscoped
   * because the wake budget protects the single Owner's attention, not a
   * per-session quota.
   */
  noteUserActivity(): void;
  stop(): Promise<void>;
}

interface SourceHandle {
  cancel(reason: "cancelled" | "source_timeout"): Promise<void>;
  stop(): Promise<void>;
  pause?(): void;
  resume?(): void;
  readonly done: Promise<void>;
}

function storeError(
  code: Trigger.StoreErrorCode,
  message: string,
  identity: { triggerId?: string; fireId?: string } = {},
): never {
  throw new Trigger.StoreError({ code, message, ...identity });
}

function pauseReasonFor(error: unknown): Trigger.PauseReason | undefined {
  if (Trigger.StoreError.isInstance(error) && error.data.code === "owner_session_missing") {
    return "owner_session_missing";
  }
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "source_unavailable" || code === "path_invalid") return "source_unavailable";
  return undefined;
}

function createNotifierAdapter(): TriggerNotifierPort {
  let state = Trigger.Notifier.initialState();
  const advance = (result: Trigger.Notifier.Result): Trigger.Notifier.Result => {
    state = result.state;
    return result;
  };
  return {
    observe: (event, now) => advance(Trigger.Notifier.observe(state, event, now)),
    flush: (now) => advance(Trigger.Notifier.flush(state, now)),
    rearm: (triggerId) => advance(Trigger.Notifier.rearm(state, triggerId)),
    noteActivity: (now) => advance(Trigger.Notifier.noteActivity(state, now)),
    dispose: () => advance(Trigger.Notifier.dispose(state)),
  };
}

/**
 * The app-side owner of Trigger effects.
 *
 * Every durable decision belongs to the protocol fold and the ledger stores;
 * the host holds only what cannot be a row: timer handles, live source handles,
 * in-flight delivery promises, and the ephemeral notifier state. Effects are
 * applied strictly AFTER their transition commits, so a crash between a commit
 * and its effect is recovered by the boot sweep rather than lost.
 */
export function createTriggerHost(deps: TriggerHostDeps): TriggerHost {
  const timer = deps.timer ?? createTriggerTimerPort(deps.clock);
  const notifier = deps.notifier ?? createNotifierAdapter();
  const sources = new Map<string, SourceHandle>();
  // The pure notifier carries only `terminal: boolean`; WHICH terminal reason a
  // summary carried is ephemeral host state until it becomes a durable Fire.
  const terminalReasons = new Map<string, Trigger.TerminalFireReason>();
  const inFlight = new Set<Promise<unknown>>();
  const queue: string[] = [];
  let draining = false;
  let drainOpen = false;
  let stopped = false;
  let flushArmed = false;

  const delivery: TriggerDelivery = createTriggerDelivery({
    clock: deps.clock,
    triggers: deps.triggers,
    fires: deps.fires,
    resident: deps.resident as Parameters<typeof createTriggerDelivery>[0]["resident"],
    ...(deps.route === undefined ? {} : { route: deps.route }),
    newFireId: deps.newFireId,
    newTraceId: deps.newTraceId,
    enqueue: (fire) => {
      enqueueFire(fire.id);
    },
  });

  function report(error: unknown, identity: { triggerId?: string; fireId?: string } = {}): void {
    deps.onOperationalError?.({ ...identity, error });
  }

  function track<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.finally(() => {
      inFlight.delete(settled);
    });
    inFlight.add(settled);
    return operation;
  }

  /**
   * The global delivery queue. Insertion is a receipt; the drain is a separate
   * pump so a tool call never waits on a Resident model turn.
   */
  function enqueueFire(fireId: string): void {
    if (stopped || queue.includes(fireId)) return;
    queue.push(fireId);
    if (drainOpen) void track(drain());
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (drainOpen && !stopped) {
        const fireId = queue.shift();
        if (fireId === undefined) return;
        try {
          await delivery.deliver(fireId);
        } catch (error) {
          // One failed delivery is isolated to its Fire: the row stays unacked
          // and the next boot replays it. Nothing else in the queue is dropped.
          report(error, { fireId });
        }
      }
    } finally {
      draining = false;
    }
  }

  function currentRecord(triggerId: string): Trigger.Record {
    const record = deps.triggers.get(triggerId);
    if (record === undefined) {
      storeError("not_found", `Trigger not found: ${triggerId}`, { triggerId });
    }
    return record;
  }

  function ownedRecord(ownerSessionId: string, triggerId: string): Trigger.Record {
    const record = currentRecord(triggerId);
    if (record.ownerSessionId !== ownerSessionId) {
      // Ownership is not a filter applied after the fact: another session's
      // Trigger is simply not found from here.
      storeError("not_found", `Trigger not found: ${triggerId}`, { triggerId });
    }
    return record;
  }

  /** Applies one committed effect set. Effects never decide durable state. */
  async function applyEffects(
    record: Trigger.Record,
    effects: readonly Trigger.SchedulerEffect[],
  ): Promise<void> {
    for (const effect of effects) {
      switch (effect.type) {
        case "arm":
          timer.arm(record.id, effect.dueAt, () => {
            void track(onTimerDue(record.id));
          });
          break;
        case "cancel_timer":
          timer.cancel(record.id);
          break;
        case "reserve_fire":
          enqueueFire(effect.fireId);
          break;
        case "activate_source":
          await activateSource(record);
          break;
        case "pause_source":
          await releaseSource(record.id, "cancelled");
          break;
        case "end":
          timer.cancel(record.id);
          await releaseSource(record.id, "cancelled");
          notifier.rearm(record.id);
          break;
      }
    }
  }

  function step(
    record: Trigger.Record,
    input: Exclude<Trigger.SchedulerInput, { type: "delivery_acknowledged" }>,
  ): Trigger.Record {
    const receipt = deps.triggers.transition({
      triggerId: record.id,
      expectedRevision: record.revision,
      input,
      traceId: deps.newTraceId(),
    });
    void track(
      applyEffects(receipt.trigger, receipt.effects).catch((error) => {
        report(error, { triggerId: record.id });
      }),
    );
    return receipt.trigger;
  }

  /**
   * A due deadline. The fold decides whether this is a fire, an expiry, or a
   * no-op re-arm; the host only supplies rendered Fire material and time.
   */
  async function onTimerDue(triggerId: string): Promise<void> {
    if (stopped) return;
    let record: Trigger.Record;
    try {
      record = currentRecord(triggerId);
    } catch (error) {
      report(error, { triggerId });
      return;
    }
    if (record.lifecycle.state === "ended") return;
    const at = triggerLogicalNow(deps.clock, record);
    const scheduledForAt = record.nextFireAt ?? scheduledInstant(record);
    try {
      const material = buildFireMaterial({
        trigger: record,
        fireId: deps.newFireId(),
        traceId: deps.newTraceId(),
        cause: "alarm",
        items: [],
        overflowCount: 0,
        firstAt: at,
        lastAt: at,
        firedAt: at,
        ...(scheduledForAt === undefined ? {} : { scheduledForAt }),
      });
      step(record, { type: "timer_due", at, fireMaterial: material });
    } catch (error) {
      report(error, { triggerId });
    }
  }

  function scheduledInstant(record: Trigger.Record): number | undefined {
    return record.source.kind === "time.once" ? record.source.at : record.nextFireAt;
  }

  /**
   * Builds the `restore` input for one durable row.
   *
   * The fold refuses to invent a Fire, so the host must hand it rendered
   * material for exactly the rows the boot matrix says fire on restore: an
   * overdue once alarm, a due recurring period before expiry, and a finite
   * source found at or past its absolute expiry. Downtime therefore costs one
   * late Fire, never a silently dropped one.
   */
  function restoreInput(
    record: Trigger.Record,
    at: number,
    cause: Extract<Trigger.FireCause, "alarm" | "recovery">,
  ): Extract<Trigger.SchedulerInput, { type: "restore" }> {
    const armed = record.lifecycle.state === "armed";
    const expiresAt = record.expiresAt;
    const scheduledForAt =
      record.source.kind === "time.once"
        ? record.source.at
        : record.source.kind === "time.every"
          ? record.nextFireAt
          : undefined;
    const dueTimeFire =
      armed &&
      scheduledForAt !== undefined &&
      at >= scheduledForAt &&
      // A recurring row at or past expiry ends instead of firing; the
      // inclusive boundary belongs to expiry, not to a last Fire.
      (record.source.kind === "time.once" || expiresAt === undefined || at < expiresAt);
    if (dueTimeFire) {
      return {
        type: "restore",
        at,
        fireMaterial: buildFireMaterial({
          trigger: record,
          fireId: deps.newFireId(),
          traceId: deps.newTraceId(),
          cause,
          items: [],
          overflowCount: 0,
          firstAt: at,
          lastAt: at,
          firedAt: at,
          ...(scheduledForAt === undefined ? {} : { scheduledForAt }),
        }),
      };
    }
    const timedOutSource =
      record.source.kind.startsWith("event.") && expiresAt !== undefined && at >= expiresAt;
    if (!timedOutSource) return { type: "restore", at };
    return {
      type: "restore",
      at,
      fireMaterial: buildFireMaterial({
        trigger: record,
        fireId: deps.newFireId(),
        traceId: deps.newTraceId(),
        cause: "source_summary",
        // The absolute lifetime elapsed while the process was down; the
        // Resident is still owed the summary that says so.
        items: [{ kind: "summary", text: "source_timeout", at }],
        overflowCount: 0,
        firstAt: at,
        lastAt: at,
        firedAt: at,
        terminalReason: "source_timeout",
      }),
    };
  }

  /** The notifier decides when a coalesced batch becomes one durable Fire. */
  function armNotifierFlush(dueAt: number): void {
    if (flushArmed || stopped) return;
    flushArmed = true;
    timer.arm("notifier:flush", dueAt, () => {
      flushArmed = false;
      void track(flushNotifier());
    });
  }

  function applyNotifierResult(result: Trigger.Notifier.Result): void {
    for (const effect of result.effects) {
      switch (effect.type) {
        case "schedule_flush":
        case "schedule_rate_limit":
          armNotifierFlush(effect.dueAt);
          break;
        case "emit":
          void track(recordObservation(effect));
          break;
        case "pause_event_triggers":
          void track(pauseEventTriggers());
          break;
      }
    }
  }

  async function flushNotifier(): Promise<void> {
    if (stopped) return;
    applyNotifierResult(notifier.flush(deps.clock.now()));
  }

  /** One emitted notifier group becomes exactly one durable observation. */
  async function recordObservation(
    emit: Extract<Trigger.Notifier.Effect, { type: "emit" }>,
  ): Promise<void> {
    let record: Trigger.Record;
    try {
      record = currentRecord(emit.triggerId);
    } catch (error) {
      report(error, { triggerId: emit.triggerId });
      return;
    }
    if (record.lifecycle.state === "ended") return;
    const at = triggerLogicalNow(deps.clock, record);
    const terminalReason = emit.terminal ? terminalReasons.get(emit.triggerId) : undefined;
    if (terminalReason !== undefined) terminalReasons.delete(emit.triggerId);
    try {
      const material = buildFireMaterial({
        trigger: record,
        fireId: deps.newFireId(),
        traceId: deps.newTraceId(),
        cause: emit.terminal ? "source_summary" : "source_line",
        items: emit.items,
        overflowCount: emit.overflowCount,
        firstAt: emit.items[0]?.at ?? at,
        lastAt: emit.items.at(-1)?.at ?? at,
        firedAt: at,
        ...(terminalReason === undefined ? {} : { terminalReason }),
      });
      if (terminalReason === undefined) {
        step(record, {
          type: "source_observation",
          batch: material.pendingBatch,
          at,
          fireMaterial: material,
        });
        return;
      }
      step(record, {
        type: "source_closed",
        reason: terminalReason,
        at,
        terminalBatch: material.pendingBatch,
        fireMaterial: material,
      });
    } catch (error) {
      report(error, { triggerId: emit.triggerId });
    }
  }

  /** The wake budget is a kernel action: every live event source is paused. */
  async function pauseEventTriggers(): Promise<void> {
    for (const record of deps.triggers.list({ states: ["armed"] })) {
      if (record.source.kind === "time.once" || record.source.kind === "time.every") continue;
      try {
        step(record, {
          type: "pause",
          reason: "wake_budget",
          at: triggerLogicalNow(deps.clock, record),
        });
      } catch (error) {
        report(error, { triggerId: record.id });
      }
    }
  }

  function sinkFor(record: Trigger.Record): EventSourceSink {
    return {
      line(text, at) {
        const sanitized = sanitizeSourceText(text);
        if (sanitized === undefined) return;
        applyNotifierResult(
          notifier.observe(
            { triggerId: record.id, kind: "line", text: sanitized, at },
            deps.clock.now(),
          ),
        );
      },
      terminal(input) {
        const sanitized = sanitizeSourceText(input.summary) ?? input.reason;
        // Remembered here because the emitted batch reports only THAT it is
        // terminal; the reason must survive coalescing to reach the Fire.
        terminalReasons.set(record.id, input.reason);
        applyNotifierResult(
          notifier.observe(
            { triggerId: record.id, kind: "summary", text: sanitized, at: input.at },
            deps.clock.now(),
          ),
        );
      },
    };
  }

  async function activateSource(record: Trigger.Record): Promise<void> {
    if (stopped || sources.has(record.id)) return;
    const sink = sinkFor(record);
    if (record.source.kind === "event.command") {
      const prepared = preflightCommandSource(record.source, {
        clock: deps.clock,
        ...(deps.commandDeps ?? { cwd: process.cwd() }),
      } as CommandSourceDeps);
      const handle: CommandSourceHandle = startCommandSource(prepared, sink, {
        clock: deps.clock,
        ...(deps.commandDeps ?? { cwd: process.cwd() }),
      } as CommandSourceDeps);
      sources.set(record.id, handle);
      return;
    }
    if (record.source.kind === "event.file") {
      const fileDeps = {
        clock: deps.clock,
        ...(deps.fileDeps ?? { cwd: process.cwd() }),
      } as FileSourceDeps;
      const prepared =
        record.fireCount > 0 || record.lastObservedAt > record.createdAt
          ? recoverFileSource(record.source, fileDeps)
          : preflightFileSource(record.source, fileDeps);
      const handle: FileSourceHandle = await startFileSource(prepared, sink, fileDeps);
      sources.set(record.id, handle);
      // The safety check is the source's own first observation, not a sleep.
      await handle.check();
    }
  }

  async function releaseSource(
    triggerId: string,
    reason: "cancelled" | "source_timeout",
  ): Promise<void> {
    const handle = sources.get(triggerId);
    if (handle === undefined) return;
    sources.delete(triggerId);
    await handle.cancel(reason);
  }

  /**
   * Activation runs after the durable create/rearm commits, so an activation
   * failure pauses a Trigger that exists rather than losing the intent.
   */
  async function activateOrPause(record: Trigger.Record): Promise<Trigger.Record> {
    try {
      await activateSource(record);
      return deps.triggers.get(record.id) ?? record;
    } catch (error) {
      const reason = pauseReasonFor(error);
      report(error, { triggerId: record.id });
      if (reason === undefined) return deps.triggers.get(record.id) ?? record;
      const latest = deps.triggers.get(record.id) ?? record;
      if (latest.lifecycle.state !== "armed") return latest;
      return step(latest, { type: "pause", reason, at: triggerLogicalNow(deps.clock, latest) });
    }
  }

  function needsSource(record: Trigger.Record): boolean {
    return record.source.kind === "event.command" || record.source.kind === "event.file";
  }

  return {
    async create(ownerSessionId, input) {
      const parsed = Trigger.Create.parse({
        ...(input as Record<string, unknown>),
        id: deps.newTriggerId(),
        ownerSessionId,
        at: deps.clock.now(),
      });
      // Refuse an unsafe source BEFORE committing, so a Trigger that can never
      // run is never created; post-commit failures only pause.
      if (parsed.source.kind === "event.command") {
        preflightCommandSource(parsed.source, {
          clock: deps.clock,
          ...(deps.commandDeps ?? { cwd: process.cwd() }),
        } as CommandSourceDeps);
      }
      if (parsed.source.kind === "event.file") {
        preflightFileSource(parsed.source, {
          clock: deps.clock,
          ...(deps.fileDeps ?? { cwd: process.cwd() }),
        } as FileSourceDeps);
      }
      const created = deps.triggers.create(parsed, deps.newTraceId());
      // A `time.once` created at or after its instant fires immediately: that
      // first step is an ordinary alarm, not crash recovery.
      const armed = step(
        created,
        restoreInput(created, triggerLogicalNow(deps.clock, created), "alarm"),
      );
      return needsSource(armed) ? activateOrPause(armed) : (deps.triggers.get(armed.id) ?? armed);
    },

    async list(ownerSessionId, includeEnded) {
      return deps.triggers.list({
        ownerSessionId,
        ...(includeEnded ? {} : { states: ["armed", "paused"] as const }),
      });
    },

    async cancel(ownerSessionId, triggerId) {
      const record = ownedRecord(ownerSessionId, triggerId);
      // Cancelling an already-ended Trigger keeps its original terminal reason
      // rather than rewriting history to `cancelled`.
      if (record.lifecycle.state === "ended") return record;
      const at = triggerLogicalNow(deps.clock, record);
      if (!record.source.kind.startsWith("event.")) {
        return step(record, { type: "cancel", at });
      }
      // Cancelling a watch owes the Resident a final Fire: otherwise a source it
      // is waiting on goes silent with no record of why.
      const material = buildFireMaterial({
        trigger: record,
        fireId: deps.newFireId(),
        traceId: deps.newTraceId(),
        cause: "source_summary",
        // A terminal batch carries exactly one summary: the reason the watch
        // stopped is the observation.
        items: [{ kind: "summary", text: "cancelled", at }],
        overflowCount: 0,
        firstAt: at,
        lastAt: at,
        firedAt: at,
        terminalReason: "cancelled",
      });
      return step(record, {
        type: "cancel",
        at,
        terminalBatch: material.pendingBatch,
        fireMaterial: material,
      });
    },

    async rearm(ownerSessionId, triggerId) {
      const record = ownedRecord(ownerSessionId, triggerId);
      const rearmed = step(record, { type: "rearm", at: triggerLogicalNow(deps.clock, record) });
      notifier.rearm(triggerId);
      return needsSource(rearmed)
        ? activateOrPause(rearmed)
        : (deps.triggers.get(triggerId) ?? rearmed);
    },

    noteUserActivity() {
      applyNotifierResult(notifier.noteActivity(deps.clock.now()));
    },

    async startRecovery() {
      // 1-2: read candidates and reconcile without acting.
      const unacked = deps.fires.listUnackedIds();
      const byTrigger = new Map<string, Trigger.Fire[]>();
      for (const fireId of unacked) {
        const fire = deps.fires.get(fireId);
        if (fire === undefined) continue;
        byTrigger.set(fire.triggerId, [...(byTrigger.get(fire.triggerId) ?? []), fire]);
      }

      const conflicts = new Map<string, Trigger.PauseReason>();
      const replayable: Trigger.Fire[] = [];
      for (const [triggerId, fires] of byTrigger) {
        const parent = deps.triggers.get(triggerId);
        if (parent === undefined) {
          report(new Error(`unacked Trigger Fire has no parent: ${triggerId}`), { triggerId });
          continue;
        }
        if (fires.length > 1) {
          // Never guess an order or deliver concurrently.
          conflicts.set(triggerId, "recovery_conflict");
          report(new Error(`Trigger ${triggerId} has ${fires.length} unacked Fires`), {
            triggerId,
          });
          continue;
        }
        if (!deps.sessions.exists(parent.ownerSessionId)) {
          conflicts.set(triggerId, "owner_session_missing");
          continue;
        }
        const fire = fires[0];
        if (fire !== undefined) replayable.push(fire);
      }

      for (const record of deps.triggers.list({ states: ["armed", "paused"] })) {
        if (record.inFlightFireId !== undefined && byTrigger.get(record.id) === undefined) {
          // A gate pointing at a Fire that is gone is corruption, not a reason
          // to synthesize one.
          conflicts.set(record.id, "recovery_conflict");
          report(new Error(`Trigger ${record.id} gate names a missing Fire`), {
            triggerId: record.id,
          });
        }
      }

      // 3: enqueue valid unacked Fires before the drain opens.
      for (const fire of [...replayable].sort(
        (left, right) => left.recordedAt - right.recordedAt || (left.id < right.id ? -1 : 1),
      )) {
        if (!conflicts.has(fire.triggerId)) enqueueFire(fire.id);
      }

      // 4-5: fold recovery for every non-ended row, then re-arm and activate.
      for (const record of deps.triggers.list({ states: ["armed", "paused"] })) {
        const pauseReason = conflicts.get(record.id);
        try {
          if (pauseReason !== undefined) {
            if (record.lifecycle.state === "armed") {
              step(record, {
                type: "pause",
                reason: pauseReason,
                at: triggerLogicalNow(deps.clock, record),
              });
            }
            continue;
          }
          const restored = step(
            record,
            restoreInput(record, triggerLogicalNow(deps.clock, record), "recovery"),
          );
          if (restored.lifecycle.state === "armed" && needsSource(restored)) {
            await activateOrPause(restored);
          }
        } catch (error) {
          // A malformed row is isolated; the sweep continues for the rest.
          report(error, { triggerId: record.id });
        }
      }

      // 6: only now may deliveries and new observations run.
      drainOpen = true;
      void track(drain());
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      drainOpen = false;
      timer.cancelAll();
      notifier.dispose();
      // Shutdown is cleanup, not cancellation: no terminal summary is emitted
      // and no armed row becomes paused.
      const handles = [...sources.values()];
      sources.clear();
      await Promise.allSettled(handles.map((handle) => handle.stop()));
      // An accepted delivery is never orphaned against a closing ledger.
      await Promise.allSettled([...inFlight]);
    },
  };
}
