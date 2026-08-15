import {
  WorkerDeliveryError,
  WorkerDriver,
  type Execution,
  type WorkerBootstrap,
} from "@openomni/protocol";
import fs from "node:fs";
import { WorkerSupervisor } from "../worker-supervision/supervisor";
import {
  type ActiveRunRegistry,
  bindToolRelayTrace,
  createActiveRun,
  normalizeDeliverTaskTrace,
} from "./worker-run-trace";
import { createPrivateSocketDir } from "./worker-socket-dir";
import {
  DEFAULT_IDLE_SHUTDOWN_MS,
  DEFAULT_MAX_ACTIVE_WORKERS,
  DEFAULT_MAX_QUEUED_DELIVERIES,
  DEFAULT_SLOT_WAIT_TIMEOUT_MS,
  HARD_MAX_ACTIVE_WORKERS,
  type DeliverTask,
  type SlotWaiter,
  type WorkerManager,
  type WorkerManagerConfig,
  type WorkerManagerStats,
  type WorkerPorts,
  type WorkerSlot,
} from "./worker-manager-types";

export function createWorkerManager(
  config: WorkerManagerConfig,
  ports: WorkerPorts,
): WorkerManager {
  return new WorkerPool(config, ports);
}

/**
 * Test-only chaos hook (#553 C9): `killWorker` is not part of the public
 * driver shape, so the coordinator's own crash-recovery test reaches the
 * pool internals through this function instead. Exported from the internal
 * worker-manager barrel only — never from the package barrel.
 */
export function killWorkerForTest(manager: WorkerManager, index: number): void {
  if (!(manager instanceof WorkerPool)) {
    throw new Error("killWorkerForTest requires a coordinator WorkerPool instance");
  }
  manager.killWorker(index);
}

// One pool module, one concept (#462 §3): the slot state machine
// (affinity → create → reclaim → waiters) and delivery orchestration were
// previously split across OnDemandWorkerManager + WorkerSlotCoordinator with
// a config-plumbing object between them. The class is intentionally not
// exported — `createWorkerManager` is the only construction path (namespace
// over classes). Execution.Driver in the implements list binds the concrete
// driver to the protocol command face (#462 §6) — drift becomes a compile
// error, not a doc.
class WorkerPool implements WorkerManager, Execution.Driver {
  // Only the two lazily-read config values are stored (#480 review W-b);
  // holding the whole raw config object invited mutation-at-a-distance.
  private readonly workerScript: string;
  private readonly workerBootstrap?: WorkerBootstrap.Bootstrap;
  private readonly ports: WorkerPorts;
  private readonly socketDir: string;
  private readonly maxActiveWorkers: number;
  private readonly idleShutdownMs: number;
  private readonly slotWaitTimeoutMs: number;
  private readonly maxQueuedDeliveries: number;
  private readonly activeRuns: ActiveRunRegistry = new Map();
  private readonly slots = new Map<number, WorkerSlot>();
  private readonly sessionAffinity = new Map<string, number>();
  private readonly waiters: SlotWaiter[] = [];
  private nextWorkerId = 0;
  private stopping = false;

  constructor(config: WorkerManagerConfig, ports: WorkerPorts) {
    this.workerScript = config.workerScript;
    this.workerBootstrap = config.bootstrap;
    this.ports = ports;
    this.socketDir = createPrivateSocketDir(config.socketDir ?? "/tmp", ports.events);
    this.maxActiveWorkers = normalizeMaxActiveWorkers(config.maxActiveWorkers);
    this.idleShutdownMs = config.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    this.slotWaitTimeoutMs = config.slotWaitTimeoutMs ?? DEFAULT_SLOT_WAIT_TIMEOUT_MS;
    this.maxQueuedDeliveries = config.maxQueuedDeliveries ?? DEFAULT_MAX_QUEUED_DELIVERIES;
  }

  async deliver(runId: string, task: DeliverTask): Promise<unknown> {
    const sessionId = task.sessionId;
    if (this.stopping) {
      throw new WorkerDeliveryError({
        message: "worker driver is shutting down",
        code: "shutting_down",
        runId,
        sessionId,
      });
    }
    if (this.activeRuns.has(runId)) {
      throw new WorkerDeliveryError({
        message: `run already active: ${runId}`,
        code: "duplicate_run",
        runId,
        sessionId,
      });
    }

    const deliveryTask = normalizeDeliverTaskTrace(task);
    const activeRun = createActiveRun(runId, deliveryTask);
    this.activeRuns.set(runId, activeRun);
    let slot: WorkerSlot;
    try {
      slot = await this.acquireSlot(sessionId, activeRun.traceId);
    } catch (error) {
      this.activeRuns.delete(runId);
      throw error;
    }
    activeRun.slot = slot;
    if (activeRun.cancelled) {
      this.activeRuns.delete(runId);
      this.releaseReservedSlot(slot);
      return {
        runId,
        sessionId,
        status: "cancelled",
        error: "cancelled before worker delivery",
      };
    }
    this.markSlotLoaded(slot);

    try {
      const supervisor = this.ensureSupervisor(slot);
      const generation = supervisor.getGeneration();
      await supervisor.waitReady();
      if (supervisor.getGeneration() !== generation) {
        throw new WorkerDeliveryError({
          message: `worker ${slot.id} restarted before run ${runId} was delivered`,
          code: "worker_restarted",
          runId,
          sessionId,
        });
      }
      if (activeRun.cancelled) {
        return {
          runId,
          sessionId,
          status: "cancelled",
          error: "cancelled before worker delivery",
        };
      }
      this.ports.events.publish(WorkerDriver.RunDelivered, {
        traceId: activeRun.traceId,
        time: Date.now(),
        workerId: slot.id,
        runId,
        sessionId,
      });
      const deliveredAt = Date.now();
      try {
        const result = await supervisor.deliver(runId, deliveryTask);
        this.publishRunSettled(
          slot.id,
          runId,
          sessionId,
          activeRun.traceId,
          "completed",
          deliveredAt,
        );
        return result;
      } catch (error) {
        const interrupted =
          error instanceof WorkerDeliveryError && error.data.code === "wall_time_exceeded";
        this.publishRunSettled(
          slot.id,
          runId,
          sessionId,
          activeRun.traceId,
          interrupted ? "interrupted" : "error",
          deliveredAt,
        );
        throw error;
      }
    } finally {
      this.activeRuns.delete(runId);
      this.releaseLoadedSlot(slot);
    }
  }

  private publishRunSettled(
    workerId: number,
    runId: string,
    sessionId: string,
    traceId: string,
    outcome: "completed" | "interrupted" | "error",
    deliveredAt: number,
  ): void {
    this.ports.events.publish(WorkerDriver.RunSettled, {
      traceId,
      time: Date.now(),
      workerId,
      runId,
      sessionId,
      outcome,
      durationMs: Date.now() - deliveredAt,
    });
  }

  async cancel(runId: string): Promise<unknown> {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun) {
      return { cancelled: false, error: `run not active: ${runId}` };
    }
    activeRun.cancelled = true;
    const supervisor = activeRun.slot?.supervisor;
    if (supervisor === undefined || supervisor === null) {
      return { cancelled: true, queued: true, runId, sessionId: activeRun.sessionId };
    }

    if (!supervisor.isReady()) {
      return { cancelled: true, starting: true, runId, sessionId: activeRun.sessionId };
    }
    return supervisor.cancel(runId, activeRun.sessionId);
  }

  async send(sessionId: string, message: string, runId?: string): Promise<unknown> {
    const activeRun = [...this.activeRuns.entries()].find(
      ([activeRunId, run]) =>
        run.sessionId === sessionId && (runId === undefined || activeRunId === runId),
    );
    if (!activeRun) {
      return { accepted: false, error: `no active worker run for session: ${sessionId}` };
    }
    const [activeRunId, run] = activeRun;
    const supervisor = run.slot?.supervisor;
    if (!supervisor?.isReady()) {
      return {
        accepted: false,
        error: `worker run not ready: ${runId ?? activeRunId}`,
      };
    }
    return supervisor.send(sessionId, message, runId ?? activeRunId);
  }

  stats(): WorkerManagerStats {
    const slots = [...this.slots.values()];
    const running = slots.filter((slot) => slot.supervisor?.isActive() === true);
    return {
      workers: running.length,
      active: running.filter((slot) => slot.load > 0).length,
      idle: running.filter((slot) => slot.load === 0).length,
      ready: running.filter((slot) => slot.supervisor?.isReady() === true).length,
      activeRuns: this.activeRuns.size,
      maxActiveWorkers: this.maxActiveWorkers,
    };
  }

  async waitUntilReady(timeoutMs = 15_000): Promise<void> {
    await Promise.all(
      [...this.slots.values()]
        .map((slot) => slot.supervisor)
        .filter((supervisor): supervisor is WorkerSupervisor => supervisor !== null)
        .map((supervisor) => supervisor.waitReady(timeoutMs)),
    );
  }

  killWorker(index: number): void {
    const slot = this.slots.get(index);
    if (!slot) return;
    if (slot.load > 0) {
      slot.supervisor?.forceKill();
      return;
    }
    const supervisor = slot.supervisor;
    slot.supervisor = null;
    this.forgetSlot(slot);
    supervisor?.dispose();
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const results = await Promise.allSettled(
      [...this.slots.values()].map(async (slot) => {
        this.clearIdleTimer(slot);
        const supervisor = slot.supervisor;
        slot.supervisor = null;
        await supervisor?.stop();
      }),
    );
    this.slots.clear();
    this.sessionAffinity.clear();
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(
        new WorkerDeliveryError({
          message: "worker driver is shutting down",
          code: "shutting_down",
        }),
      );
    }
    this.activeRuns.clear();
    fs.rmSync(this.socketDir, { recursive: true, force: true });

    const failures = results.filter(
      (r): r is PromiseSettledResult<void> & { status: "rejected" } => r.status === "rejected",
    );
    if (failures.length > 0) {
      const err = new Error(`${failures.length} worker(s) failed to stop cleanly`);
      (err as Error & { errors: unknown[] }).errors = failures.map((f) => f.reason);
      throw err;
    }
  }

  // --- slot state machine: affinity → create → reclaim → waiters ---

  private async acquireSlot(sessionId: string, traceId: string): Promise<WorkerSlot> {
    while (!this.stopping) {
      const slot = await this.tryAcquireSlot(sessionId);
      if (slot) return slot;
      await this.waitForSlot(traceId);
    }
    throw new WorkerDeliveryError({
      message: "worker driver is shutting down",
      code: "shutting_down",
      sessionId,
    });
  }

  private releaseReservedSlot(slot: WorkerSlot): void {
    slot.reserved = false;
    if (slot.load !== 0) return;
    this.releaseOneWaiter();
    this.scheduleIdleShutdown(slot);
  }

  private markSlotLoaded(slot: WorkerSlot): void {
    slot.load += 1;
    slot.reserved = false;
    this.clearIdleTimer(slot);
  }

  private releaseLoadedSlot(slot: WorkerSlot): void {
    const wasLoaded = slot.load > 0;
    if (wasLoaded) slot.load -= 1;
    if (wasLoaded && slot.load === 0) {
      this.releaseOneWaiter();
      this.scheduleIdleShutdown(slot);
    }
  }

  private ensureSupervisor(slot: WorkerSlot): WorkerSupervisor {
    if (slot.supervisor?.isActive() === true) return slot.supervisor;

    // A non-active supervisor still occupying the slot is one that crashed and
    // is sitting in restart backoff with its restart timer armed. Replacing it
    // without disposing first orphans that timer — it keeps re-spawning forever
    // and double-spawns on the slot's single socket path. dispose() flips
    // `stopping` (which neutralizes the pending restart) and kills any lingering
    // process, so exactly one supervisor owns the slot after this point.
    slot.supervisor?.dispose();

    slot.supervisor = new WorkerSupervisor({
      id: slot.id,
      script: this.workerScript,
      events: this.ports.events,
      socketDir: this.socketDir,
      bootstrap: this.workerBootstrap,
      toolRelay: bindToolRelayTrace(this.ports.toolRelay, this.activeRuns, slot),
      inboundWait: this.ports.inboundWait,
    });
    return slot.supervisor;
  }

  private async tryAcquireSlot(sessionId: string): Promise<WorkerSlot | undefined> {
    const affinityId = this.sessionAffinity.get(sessionId);
    const affinitySlot = affinityId === undefined ? undefined : this.slots.get(affinityId);
    if (affinitySlot !== undefined && affinitySlot.ownerSessionId === sessionId) {
      if (affinitySlot.load > 0 || affinitySlot.reserved) return undefined;
      affinitySlot.reserved = true;
      return affinitySlot;
    }

    if (this.slots.size < this.maxActiveWorkers) {
      const slot = this.createSlot(sessionId);
      this.sessionAffinity.set(sessionId, slot.id);
      return slot;
    }

    const reusable = this.findReusableIdleSlot();
    if (reusable) return this.reassignSlot(reusable, sessionId);
    return undefined;
  }

  private waitForSlot(traceId: string): Promise<void> {
    if (this.waiters.length >= this.maxQueuedDeliveries) {
      // The saturation belongs to the delivery that hit it — the same trace
      // RunDelivered/RunSettled already carry (D11).
      this.ports.events.publish(WorkerDriver.QueueSaturated, {
        traceId,
        time: Date.now(),
        queued: this.waiters.length,
        maxQueuedDeliveries: this.maxQueuedDeliveries,
      });
      return Promise.reject(
        new WorkerDeliveryError({ message: "worker delivery queue is full", code: "queue_full" }),
      );
    }
    return new Promise((resolve, reject) => {
      const waiter = {} as SlotWaiter;
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(
          new WorkerDeliveryError({
            message: `worker slot wait timed out after ${this.slotWaitTimeoutMs}ms`,
            code: "slot_wait_timeout",
          }),
        );
      }, this.slotWaitTimeoutMs);
      waiter.resolve = () => {
        clearTimeout(timer);
        resolve();
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.waiters.push(waiter);
    });
  }

  private releaseOneWaiter(): void {
    this.waiters.shift()?.resolve();
  }

  private findReusableIdleSlot(): WorkerSlot | undefined {
    for (const slot of this.slots.values()) {
      if (slot.load === 0 && !slot.reserved) return slot;
    }
    return undefined;
  }

  private async reassignSlot(slot: WorkerSlot, sessionId: string): Promise<WorkerSlot> {
    slot.reserved = true;
    this.clearIdleTimer(slot);
    this.forgetSlotAffinity(slot.id);
    const supervisor = slot.supervisor;
    slot.supervisor = null;
    await supervisor?.stop();
    slot.ownerSessionId = sessionId;
    this.sessionAffinity.set(sessionId, slot.id);
    return slot;
  }

  private createSlot(ownerSessionId: string): WorkerSlot {
    const slot: WorkerSlot = {
      id: this.nextWorkerId,
      ownerSessionId,
      supervisor: null,
      load: 0,
      reserved: true,
      idleTimer: null,
    };
    this.nextWorkerId += 1;
    this.slots.set(slot.id, slot);
    return slot;
  }

  private scheduleIdleShutdown(slot: WorkerSlot): void {
    this.clearIdleTimer(slot);
    if (this.idleShutdownMs < 0) return;

    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = null;
      if (this.stopping || slot.load > 0) return;
      slot.reserved = true;
      this.shutdownIdleSlot(slot).catch(() => {
        slot.reserved = false;
        this.releaseOneWaiter();
      });
    }, this.idleShutdownMs);
  }

  private async shutdownIdleSlot(slot: WorkerSlot): Promise<void> {
    if (this.stopping || slot.load > 0) {
      slot.reserved = false;
      return;
    }

    const supervisor = slot.supervisor;
    if (!supervisor) {
      this.forgetSlot(slot);
      this.releaseOneWaiter();
      return;
    }

    const stopped = await supervisor.shutdownIdle();
    if (slot.supervisor !== supervisor) return;

    if (stopped) {
      slot.supervisor = null;
      this.forgetSlot(slot);
      this.releaseOneWaiter();
      return;
    }

    slot.reserved = false;
    this.releaseOneWaiter();
    if (slot.load === 0) {
      this.scheduleIdleShutdown(slot);
    }
  }

  private forgetSlot(slot: WorkerSlot): void {
    this.clearIdleTimer(slot);
    this.slots.delete(slot.id);
    this.forgetSlotAffinity(slot.id);
  }

  private forgetSlotAffinity(workerId: number): void {
    for (const [sessionId, affinityId] of this.sessionAffinity.entries()) {
      if (affinityId === workerId) this.sessionAffinity.delete(sessionId);
    }
  }

  private clearIdleTimer(slot: WorkerSlot): void {
    if (slot.idleTimer === null) return;
    clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
  }
}

function normalizeMaxActiveWorkers(value: number | undefined): number {
  const requested = value ?? DEFAULT_MAX_ACTIVE_WORKERS;
  if (!Number.isFinite(requested) || requested < 1) return DEFAULT_MAX_ACTIVE_WORKERS;
  return Math.min(Math.floor(requested), HARD_MAX_ACTIVE_WORKERS);
}
