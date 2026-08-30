import { Deadline, Delegation, NamedError, newTraceId, Operational, type BusEvent } from "@openomni/protocol";
import { DelegationStore } from "@openomni/ledger";
import type { WorkItemLinkage } from "./work-item-linkage";
import { delegationTraceId } from "./trace";
import { z } from "zod";
import {
  admit,
  type Admitted,
  type AdmissionLimits,
  AdmissionRefusal,
  type DelegationOrigin,
} from "./admission";

/** What a transport reports after it has been dispatched. */
export type DriverOutcome =
  | {
      readonly status: "completed";
      readonly output: string;
      /** Transport-reported spend; visibility only, never an admission input. */
      readonly usage?: { readonly tokens: number };
    }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "cancelled"; readonly reason: string }
  | { readonly status: "delivery_failed"; readonly reason: string }
  | { readonly status: "sent" };

/** Transport identifiers allocated before the durable record is written. */
export interface DriverPreparation {
  readonly waitId?: string;
}

/**
 * The only callback a driver receives from the lifecycle owner. A driver may
 * report transport acceptance, but it cannot mutate a delegation record.
 */
export interface DriverReport {
  delivered(): void;
}

export interface DelegationDriver {
  /** Optional prepare phase; channel uses it to allocate a durable waitId. */
  prepare?(admitted: Admitted, handle: Delegation.Handle): DriverPreparation | Promise<DriverPreparation>;
  run(
    admitted: Admitted,
    handle: Delegation.Handle,
    signal: AbortSignal,
    report?: DriverReport,
  ): Promise<DriverOutcome>;
}

interface DelegationStorePort {
  create(record: Delegation.Record): Delegation.Record;
  claimOpenWithinRoot(
    record: Delegation.Record,
    maxFanout: number,
    constraints?: { readonly requireOpenParent?: string },
  ):
    | { readonly claimed: true; readonly record: Delegation.Record }
    | { readonly claimed: false; readonly reason: "fanout_cap" | "parent_settled" };
  get(delegationId: string): Delegation.Record | undefined;
  /** Legacy test-port shape; production uses settleOnce for the CAS receipt. */
  settle?(delegationId: string, settlement: Delegation.Settled): Delegation.Settled | undefined;
  settleOnce?(
    delegationId: string,
    settlement: Delegation.Settled,
  ): { readonly committed: boolean; readonly settlement?: Delegation.Settled };
  listOpen(): Delegation.Record[];
  listSettledUnwoken(): Delegation.Record[];
  markWoken(delegationId: string, wokenAt: number): boolean;
  countOpenByRoot(rootDelegationId: string): number;
  findByWaitId(waitId: string): Delegation.Record | undefined;
}

export interface DelegationWake {
  readonly record: Delegation.Record;
  readonly settlement: Delegation.Settled;
  readonly message: string;
}

export interface DelegationKernelOptions {
  readonly drivers: Partial<Record<Delegation.Transport, DelegationDriver>>;
  readonly now: () => number;
  readonly newDelegationId: () => string;
  readonly limits?: AdmissionLimits;
  readonly store?: DelegationStorePort;
  /** Observation sink. Events are published only after the corresponding write. */
  readonly events?: BusEvent.Sink;
  /** Alias for callers that name the observation port `sink`. */
  readonly sink?: BusEvent.Sink;
  /** Required owner-session wake delivery after every non-inline settlement. */
  readonly wake: (wake: DelegationWake) => void | Promise<void>;
  /** Tests and composition roots may defer recovery until the wake target exists. */
  readonly bootSweep?: boolean;
  /**
   * WorkItem commissioning for assign. A kernel without this port refuses
   * assign at admission — an assign without a WorkItem violates the record
   * schema, so the door stays closed rather than half-open.
   */
  readonly workItems?: WorkItemLinkage;
}

type DelegationResult =
  | { readonly refused: string; readonly error: AdmissionRefusal }
  | { readonly handle: Delegation.Handle; readonly settled?: Delegation.Settled };

type DelegationAwaitResult =
  | { readonly kind: "settled"; readonly settlement: Delegation.Settled }
  | { readonly kind: "timeout"; readonly delegationId: string; readonly deadline: number };

const DEFAULT_LIMITS: Required<AdmissionLimits> = { maxInlineDepth: 2, maxFanout: 8 };
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const NOOP_EVENTS: BusEvent.Sink = { publish: () => undefined };

function nextTimerDelay(now: number, deadline: number): number {
  return Math.min(Math.max(0, deadline - now), MAX_TIMER_DELAY_MS);
}

const DelegationControlError = NamedError.create(
  "DelegationControlError",
  z.object({
    code: z.enum(["not_found", "not_open"]),
    delegationId: z.string().min(1),
    message: z.string().min(1),
  }),
);

// A module-level notification registry lets a fresh kernel in the same host
// await a record settled by the previous kernel without polling or sleeps.
interface SettlementWaiter {
  readonly settle: (settlement: Delegation.Settled) => void;
  readonly stop: () => void;
}
const settlementWaiters = new Map<string, Set<SettlementWaiter>>();

function settlementKey(settlement: Delegation.Settled): string {
  return JSON.stringify(settlement);
}

function summaryOf(settlement: Delegation.Settled): string {
  switch (settlement.status) {
    case "completed":
      return settlement.output || "completed";
    case "failed":
      return settlement.error;
    case "cancelled":
      return settlement.reason;
    case "delivery_failed":
      return settlement.reason;
    case "no_response":
      return "no response before the deadline; outcome unknown";
    case "interrupted":
      return "host restarted while the work was in flight; outcome unknown";
    case "sent":
      return "message accepted by the transport";
  }
}

/** One rendering owner for every model-facing settlement result and wake. */
export function formatSettlement(settlement: Delegation.Settled): string {
  switch (settlement.status) {
    case "completed":
      return settlement.output;
    case "failed":
      return `worker failed: ${settlement.error}`;
    case "cancelled":
      return `worker cancelled: ${settlement.reason}`;
    case "delivery_failed":
      return `never reached a worker: ${settlement.reason}`;
    case "no_response":
      return "no response before the deadline — the outcome is unknown, not a failure to act";
    case "interrupted":
      return "the host restarted while the work was in flight — the outcome is unknown";
    case "sent":
      return "message sent";
  }
}

function outcomeToSettlement(
  delegationId: string,
  outcome: DriverOutcome,
  at: number,
): Delegation.Settled {
  switch (outcome.status) {
    case "completed":
      return {
        status: "completed",
        delegationId,
        output: outcome.output,
        at,
        ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
      };
    case "failed":
      return { status: "failed", delegationId, error: outcome.error, at };
    case "cancelled":
      return { status: "cancelled", delegationId, reason: outcome.reason, at };
    case "delivery_failed":
      return { status: "delivery_failed", delegationId, reason: outcome.reason, at };
    case "sent":
      return { status: "sent", delegationId, at };
  }
}

function stoppedKernelError(): Error {
  return new Error("delegation kernel has been stopped");
}

function controlError(code: "not_found" | "not_open", delegationId: string): NamedError {
  // Constructed lazily below after the concrete schema is declared.
  return new DelegationControlError({
    code,
    delegationId,
    message: code === "not_found" ? `delegation ${delegationId} was not found` : `delegation ${delegationId} is not open`,
  });
}

export interface DelegationKernel {
  readonly now: () => number;
  delegate(candidate: unknown, origin: DelegationOrigin): Promise<DelegationResult>;
  awaitDelegation(delegationId: string, timeoutMs?: number): Promise<DelegationAwaitResult>;
  cancelDelegation(delegationId: string): Promise<Delegation.Settled>;
  /** Alias used by the model-facing control tool. */
  readonly await: (delegationId: string, timeoutMs?: number) => Promise<DelegationAwaitResult>;
  /** Alias used by the model-facing control tool. */
  readonly cancel: (delegationId: string) => Promise<Delegation.Settled>;
  /** Correlated channel replies enter here; false means ordinary Resident traffic. */
  settleFromReply(waitId: string, text: string): boolean;
  /** Runs the restart sweep once. */
  start(): void;
  /** Clears timers and aborts local work without changing durable state. */
  stop(): void;
}

export function createDelegationKernel(options: DelegationKernelOptions): DelegationKernel {
  const limits: Required<AdmissionLimits> = {
    maxInlineDepth: options.limits?.maxInlineDepth ?? DEFAULT_LIMITS.maxInlineDepth,
    maxFanout: options.limits?.maxFanout ?? DEFAULT_LIMITS.maxFanout,
  };
  const store = options.store ?? DelegationStore;
  const events = options.events ?? options.sink ?? NOOP_EVENTS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const controllers = new Map<string, AbortController>();
  const delivered = new Set<string>();
  const emittedSettlements = new Set<string>();
  const ownedWaiters = new Set<SettlementWaiter>();
  let recovered = false;
  let stopped = false;

  function publishAdmitted(record: Delegation.Record): void {
    events.publish(Delegation.Events.Admitted, {
      delegationId: record.delegationId,
      traceId: delegationTraceId(record.delegationId),
      time: record.createdAt,
      operation: record.operation,
      addressKind: record.address.kind,
      transport: record.transport,
      deadline: record.deadline,
      rootDelegationId: record.rootDelegationId,
    });
  }

  function reportDelivered(handle: Delegation.Handle): void {
    if (delivered.has(handle.delegationId)) return;
    delivered.add(handle.delegationId);
    events.publish(Delegation.Events.Delivered, {
      delegationId: handle.delegationId,
      traceId: delegationTraceId(handle.delegationId),
      time: options.now(),
      transport: handle.transport,
    });
  }

  function notifyAwaiters(settlement: Delegation.Settled): void {
    const waiters = settlementWaiters.get(settlement.delegationId);
    if (waiters === undefined) return;
    settlementWaiters.delete(settlement.delegationId);
    for (const waiter of waiters) waiter.settle(settlement);
  }

  function clearTimer(delegationId: string): void {
    const timer = timers.get(delegationId);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(delegationId);
  }

  /**
   * The one terminal fold. The store CAS is the authority; event publication,
   * waiter notification, timer cleanup, and wake delivery happen only after
   * that CAS has recorded the settlement.
   */
  function settle(delegationId: string, candidate: Delegation.Settled): Delegation.Settled | undefined {
    const current = store.get(delegationId);
    if (current === undefined) return undefined;
    if (current.status === "settled") return current.settled;
    if (emittedSettlements.has(delegationId)) return store.get(delegationId)?.settled;

    const parsed = Delegation.Settled.parse({ ...candidate, delegationId });
    const receipt =
      store.settleOnce?.(delegationId, parsed) ??
      (() => {
        const recorded = store.settle?.(delegationId, parsed);
        if (recorded === undefined) return { committed: false };
        return {
          committed: settlementKey(recorded) === settlementKey(parsed),
          settlement: recorded,
        };
      })();
    if (!receipt.committed) return receipt.settlement ?? store.get(delegationId)?.settled;

    const persisted = store.get(delegationId);
    if (persisted?.status !== "settled" || persisted.settled === undefined) {
      return receipt.settlement;
    }
    const winner = persisted.settled;

    emittedSettlements.add(delegationId);
    clearTimer(delegationId);
    events.publish(Delegation.Events.Settled, {
      delegationId,
      traceId: delegationTraceId(delegationId),
      time: persisted.settledAt ?? winner.at,
      status: winner.status,
    });
    notifyAwaiters(winner);

    const controller = controllers.get(delegationId);
    if (controller !== undefined) {
      controllers.delete(delegationId);
      controller.abort();
    }

    // Settlement closes the commissioned attempt: the worker's report is
    // demoted to Evidence and the attempt records its outcome. The fold stays
    // synchronous, so the ledger write runs behind it and reports its own
    // failure instead of blocking settlement.
    const workItems = options.workItems;
    if (persisted.operation === "assign" && persisted.workItemId !== undefined && workItems !== undefined) {
      void Promise.resolve()
        .then(() =>
          workItems.closeAttempt({ record: persisted, settlement: winner }),
        )
        .catch((error: unknown) => {
          events.publish(Operational.Events.Error, {
            traceId: delegationTraceId(delegationId),
            sessionId: persisted.origin.sessionId,
            time: options.now(),
            component: "delegation",
            msg: `WorkItem attempt close failed for ${delegationId}`,
            error: error instanceof Error ? error.message : String(error),
            context: { delegationId, workItemId: persisted.workItemId ?? "" },
          });
        });
    }

    if (persisted.transport !== "inline") deliverWake(persisted, winner);
    return winner;
  }

  function deliverWake(record: Delegation.Record, settlement: Delegation.Settled): void {
    const message = `delegation ${record.delegationId} settled: ${settlement.status}: ${summaryOf(settlement)}`;
    const reportFailure = (error: unknown): void => {
      const detail = error instanceof Error ? error.message : String(error);
      events.publish(Operational.Events.Error, {
        traceId: delegationTraceId(record.delegationId),
        sessionId: record.origin.sessionId,
        time: options.now(),
        component: "delegation",
        msg: `delegation wake failed for ${record.delegationId}`,
        error: detail,
        context: { delegationId: record.delegationId },
      });
    };
    const recordSuccess = (): void => {
      try {
        store.markWoken(record.delegationId, options.now());
      } catch (error) {
        reportFailure(error);
      }
    };
    try {
      const delivery = options.wake({ record, settlement, message });
      if (delivery === undefined) {
        recordSuccess();
        return;
      }
      void Promise.resolve(delivery).then(recordSuccess, reportFailure);
    } catch (error) {
      reportFailure(error);
    }
  }

  function arm(record: Delegation.Record): void {
    if (record.status !== "open" || timers.has(record.delegationId)) return;
    const timer = setTimeout(() => {
      timers.delete(record.delegationId);
      const current = store.get(record.delegationId);
      if (current?.status !== "open") return;
      const now = options.now();
      if (!Deadline.isExpired(now, current.deadline)) {
        arm(current);
        return;
      }
      settle(current.delegationId, {
        status: "no_response",
        delegationId: current.delegationId,
        deadline: current.deadline,
        at: Math.max(now, current.deadline),
      });
    }, nextTimerDelay(options.now(), record.deadline));
    // Timers are lifecycle guards, not process-liveness handles.
    const unref = (timer as unknown as { unref?: () => void }).unref;
    unref?.call(timer);
    timers.set(record.delegationId, timer);
  }

  function recover(): void {
    if (recovered || stopped) return;
    recovered = true;
    const workItems = options.workItems;
    if (workItems !== undefined) {
      // Re-close attempts whose settlement committed but whose ledger write
      // was lost before the restart (closeAttempt is idempotent).
      void workItems.recoverAttempts((delegationId) => store.get(delegationId)).catch(
        (error: unknown) => {
          events.publish(Operational.Events.Error, {
            traceId: newTraceId(),
            time: options.now(),
            component: "delegation",
            msg: "WorkItem attempt recovery sweep failed",
            error: error instanceof Error ? error.message : String(error),
            context: {},
          });
        },
      );
    }
    for (const record of store.listSettledUnwoken()) {
      if (record.transport !== "inline" && record.settled !== undefined) {
        deliverWake(record, record.settled);
      }
    }
    for (const record of store.listOpen()) {
      const now = options.now();
      if (Deadline.isExpired(now, record.deadline)) {
        settle(record.delegationId, {
          status: "no_response",
          delegationId: record.delegationId,
          deadline: record.deadline,
          at: Math.max(now, record.deadline),
        });
        continue;
      }
      if (record.transport === "inline" || record.transport === "process") {
        settle(record.delegationId, {
          status: "interrupted",
          delegationId: record.delegationId,
          at: now,
        });
        continue;
      }
      // Channel records retain their durable Wait correlation across a host
      // restart; only the timer is process-local and must be re-armed.
      arm(record);
    }
  }

  function dispatch(
    admitted: Admitted,
    handle: Delegation.Handle,
    controller: AbortController,
  ): Promise<Delegation.Settled | undefined> {
    const driver = options.drivers[handle.transport];
    if (driver === undefined) {
      return Promise.resolve(
        settle(handle.delegationId, {
          status: "delivery_failed",
          delegationId: handle.delegationId,
          reason: `no driver for ${handle.transport} transport`,
          at: options.now(),
        }),
      );
    }

    const report: DriverReport = { delivered: () => reportDelivered(handle) };
    const completion = (async () => {
      try {
        const outcome = await driver.run(admitted, handle, controller.signal, report);
        if (stopped) return undefined;
        const settlement = outcomeToSettlement(handle.delegationId, outcome, options.now());
        return settle(handle.delegationId, settlement);
      } catch (error) {
        if (stopped) return undefined;
        return settle(handle.delegationId, {
          status: "failed",
          delegationId: handle.delegationId,
          error: error instanceof Error ? error.message : String(error),
          at: options.now(),
        });
      }
    })();
    return completion;
  }

  async function delegate(candidate: unknown, origin: DelegationOrigin): Promise<DelegationResult> {
    if (stopped) {
      throw stoppedKernelError();
    }
    const now = options.now();
    const delegationId = options.newDelegationId();
    const parentDelegationId = origin.parentDelegationId;
    const parent = parentDelegationId === undefined ? undefined : store.get(parentDelegationId);
    const rootDelegationId = parent?.rootDelegationId ?? delegationId;
    const decision = admit(candidate, origin, now, limits, {
      delegationId,
      rootDelegationId,
      ...(parent === undefined ? {} : { parent }),
      ...(parentDelegationId !== undefined && parent === undefined ? { parentMissing: true } : {}),
      openFanout: store.countOpenByRoot(rootDelegationId),
    });
    if (!decision.ok) return { refused: decision.reason, error: decision.error };

    const baseHandle: Delegation.Handle = {
      delegationId,
      operation: decision.request.operation,
      address: decision.request.address,
      transport: decision.transport,
      deadline: decision.effectiveDeadline,
      ...(decision.parentDelegationId === undefined
        ? {}
        : { parentDelegationId: decision.parentDelegationId }),
      rootDelegationId: decision.rootDelegationId,
    };

    const driver = options.drivers[decision.transport];
    let handle = baseHandle;
    if (driver?.prepare !== undefined) {
      try {
        const prepared = await driver.prepare(decision, baseHandle);
        handle = Delegation.Handle.parse({
          ...baseHandle,
          ...(prepared.waitId === undefined ? {} : { waitId: prepared.waitId }),
        });
      } catch (error) {
        const message = `transport preparation failed: ${error instanceof Error ? error.message : String(error)}`;
        return {
          refused: message,
          error: new AdmissionRefusal({ code: "prepare_failed", message }),
        };
      }
    }

    let workItemId: string | undefined;
    if (decision.request.operation === "assign") {
      if (options.workItems === undefined) {
        const message = "assign requires the WorkItem linkage and this kernel carries none";
        return { refused: message, error: new AdmissionRefusal({ code: "work_item_failed", message }) };
      }
      try {
        workItemId = await options.workItems.openAssign({
          delegationId,
          transport: decision.transport,
          instruction: decision.request.payload.text,
          acceptanceCriteria: decision.request.acceptanceCriteria ?? [],
          sessionId: origin.sessionId,
        });
      } catch (error) {
        const message = `WorkItem commissioning failed: ${error instanceof Error ? error.message : String(error)}`;
        return { refused: message, error: new AdmissionRefusal({ code: "work_item_failed", message }) };
      }
    }

    const recordOrigin: DelegationOrigin = {
      role: origin.role,
      depth: origin.depth,
      sessionId: origin.sessionId,
      ...(decision.parentDelegationId === undefined
        ? {}
        : {
            parentDelegationId: decision.parentDelegationId,
            rootDelegationId: decision.rootDelegationId,
          }),
    };
    const record = Delegation.Record.parse({
      ...handle,
      origin: Delegation.Origin.parse(recordOrigin),
      instruction: decision.request.payload.text,
      status: "open",
      createdAt: now,
      ...(workItemId === undefined ? {} : { workItemId }),
    });
    const claim = store.claimOpenWithinRoot(record, limits.maxFanout, {
      ...(record.parentDelegationId === undefined
        ? {}
        : { requireOpenParent: record.parentDelegationId }),
    });
    if (!claim.claimed) {
      if (workItemId !== undefined) {
        try {
          await options.workItems?.cancelAssign(workItemId);
        } catch (error) {
          events.publish(Operational.Events.Error, {
            traceId: delegationTraceId(record.delegationId),
            sessionId: record.origin.sessionId,
            time: options.now(),
            component: "delegation",
            msg: `WorkItem rollback failed for ${record.delegationId}`,
            error: error instanceof Error ? error.message : String(error),
            context: {
              delegationId: record.delegationId,
              workItemId,
              refusal: claim.reason,
            },
          });
        }
      }
      const message =
        claim.reason === "parent_settled"
          ? `parent delegation ${record.parentDelegationId ?? ""} is already settled`
          : `delegation fanout is capped at ${limits.maxFanout} open records for root ${record.rootDelegationId}`;
      return {
        refused: message,
        error: new AdmissionRefusal({ code: claim.reason, message }),
      };
    }
    publishAdmitted(record);
    arm(record);

    const controller = new AbortController();
    controllers.set(handle.delegationId, controller);
    const completion = dispatch(decision, handle, controller);

    // Inline is intentionally volatile and awaited. Await the durable fold,
    // rather than the driver promise alone, so an uncooperative worker still
    // returns the timer's no_response settlement at the effective deadline.
    // Notify likewise waits only until transport acceptance (or its deadline).
    if (handle.transport === "inline" || handle.operation === "notify") {
      const settled = await awaitDelegation(handle.delegationId);
      if (settled.kind === "timeout") {
        throw new Error(`delegation ${handle.delegationId} remained open at its deadline`);
      }
      return { handle, settled: settled.settlement };
    }

    // Process/channel ask|assign are durable background work. The handle is
    // returned without waiting for a result; the settlement fold will wake the
    // owner session later.
    void completion;
    return { handle };
  }

  function awaitDelegation(
    delegationId: string,
    timeoutMs?: number,
  ): Promise<DelegationAwaitResult> {
    if (stopped) return Promise.reject(stoppedKernelError());
    const record = store.get(delegationId);
    if (record === undefined) return Promise.reject(controlError("not_found", delegationId));
    if (record.status === "settled") {
      if (record.settled === undefined) return Promise.reject(controlError("not_open", delegationId));
      return Promise.resolve({ kind: "settled", settlement: record.settled });
    }

    const now = options.now();
    const requestedEnd = timeoutMs === undefined ? record.deadline : now + timeoutMs;
    const end = Deadline.clampToParent(requestedEnd, record.deadline);
    if (Deadline.isExpired(now, end)) {
      if (Deadline.isExpired(now, record.deadline)) {
        const settled = settle(delegationId, {
          status: "no_response",
          delegationId,
          deadline: record.deadline,
          at: Math.max(now, record.deadline),
        });
        if (settled !== undefined) return Promise.resolve({ kind: "settled", settlement: settled });
      }
      return Promise.resolve({ kind: "timeout", delegationId, deadline: record.deadline });
    }

    return new Promise<DelegationAwaitResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let waiters = settlementWaiters.get(delegationId);
      if (waiters === undefined) {
        waiters = new Set();
        settlementWaiters.set(delegationId, waiters);
      }
      const removeWaiter = (): void => {
        waiters?.delete(waiter);
        ownedWaiters.delete(waiter);
        if (waiters?.size === 0) settlementWaiters.delete(delegationId);
      };
      const waiter: SettlementWaiter = {
        settle: (settlement) => {
          if (timer !== undefined) clearTimeout(timer);
          ownedWaiters.delete(waiter);
          resolve({ kind: "settled", settlement });
        },
        stop: () => {
          if (timer !== undefined) clearTimeout(timer);
          removeWaiter();
          reject(stoppedKernelError());
        },
      };
      waiters.add(waiter);
      ownedWaiters.add(waiter);
      // Close the check/register race without polling: settlement is a sync
      // fold, so a settled row here can only have won between the first read
      // and registration in another host/kernel.
      const latest = store.get(delegationId);
      if (latest?.status === "settled" && latest.settled !== undefined) {
        removeWaiter();
        waiter.settle(latest.settled);
        return;
      }
      const deadlineBound = end === record.deadline;
      const scheduleAwaitTimeout = (): void => {
        timer = setTimeout(() => {
          const currentNow = options.now();
          if (!Deadline.isExpired(currentNow, end)) {
            scheduleAwaitTimeout();
            return;
          }
          removeWaiter();
          if (deadlineBound) {
            const settled = settle(delegationId, {
              status: "no_response",
              delegationId,
              deadline: record.deadline,
              at: Math.max(currentNow, record.deadline),
            });
            if (settled !== undefined) {
              resolve({ kind: "settled", settlement: settled });
              return;
            }
          }
          resolve({ kind: "timeout", delegationId, deadline: record.deadline });
        }, nextTimerDelay(options.now(), end));
        const unref = (timer as unknown as { unref?: () => void }).unref;
        unref?.call(timer);
      };
      scheduleAwaitTimeout();
    });
  }

  async function cancelDelegation(delegationId: string): Promise<Delegation.Settled> {
    const record = store.get(delegationId);
    if (record === undefined) throw controlError("not_found", delegationId);
    if (record.status === "settled") {
      if (record.settled === undefined) throw controlError("not_open", delegationId);
      return record.settled;
    }
    const settled = settle(delegationId, {
      status: "cancelled",
      delegationId,
      reason: "cancelled by the requester",
      at: options.now(),
    });
    if (settled === undefined) throw controlError("not_open", delegationId);
    return settled;
  }

  function settleFromReply(waitId: string, text: string): boolean {
    const record = store.findByWaitId(waitId);
    if (record === undefined || record.status !== "open") return false;
    if (record.transport !== "channel" || record.operation === "notify") return false;
    return (
      settle(record.delegationId, {
        status: "completed",
        delegationId: record.delegationId,
        output: text,
        at: options.now(),
      }) !== undefined
    );
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    for (const waiter of [...ownedWaiters]) waiter.stop();
  }

  const kernel: DelegationKernel = {
    now: options.now,
    delegate,
    awaitDelegation,
    cancelDelegation,
    await: awaitDelegation,
    cancel: cancelDelegation,
    settleFromReply,
    start: recover,
    stop,
  };
  if (options.bootSweep !== false) recover();
  return kernel;
}
