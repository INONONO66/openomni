import { WorkerDeliveryError } from "@openomni/protocol";
import { WorkerSupervisor } from "../worker-supervision/supervisor";
import type {
  SlotWaiter,
  WorkerManagerConfig,
  WorkerManagerStats,
  WorkerPorts,
  WorkerSlot,
} from "./worker-manager-types";

export class WorkerSlotCoordinator {
  private readonly slots = new Map<number, WorkerSlot>();
  private readonly sessionAffinity = new Map<string, number>();
  private readonly waiters: SlotWaiter[] = [];
  private nextWorkerId = 0;

  constructor(
    private readonly config: {
      readonly managerConfig: WorkerManagerConfig;
      readonly ports: WorkerPorts;
      readonly socketDir: string;
      readonly maxActiveWorkers: number;
      readonly idleShutdownMs: number;
      readonly slotWaitTimeoutMs: number;
      readonly maxQueuedDeliveries: number;
      readonly isStopping: () => boolean;
    },
  ) {}

  async acquireSlot(sessionId: string): Promise<WorkerSlot> {
    while (!this.config.isStopping()) {
      const slot = await this.tryAcquireSlot(sessionId);
      if (slot) return slot;
      await this.waitForSlot();
    }
    throw new WorkerDeliveryError({
      message: "worker driver is shutting down",
      code: "shutting_down",
      sessionId,
    });
  }

  releaseReservedSlot(slot: WorkerSlot): void {
    slot.reserved = false;
    if (slot.load !== 0) return;
    this.releaseOneWaiter();
    this.scheduleIdleShutdown(slot);
  }

  markSlotLoaded(slot: WorkerSlot): void {
    slot.load += 1;
    slot.reserved = false;
    this.clearIdleTimer(slot);
  }

  releaseLoadedSlot(slot: WorkerSlot): void {
    const wasLoaded = slot.load > 0;
    if (wasLoaded) slot.load -= 1;
    if (wasLoaded && slot.load === 0) {
      this.releaseOneWaiter();
      this.scheduleIdleShutdown(slot);
    }
  }

  ensureSupervisor(slot: WorkerSlot): WorkerSupervisor {
    if (slot.supervisor?.isActive() === true) return slot.supervisor;

    const managerConfig = this.config.managerConfig;
    const ports = this.config.ports;
    slot.supervisor = new WorkerSupervisor(
      slot.id,
      managerConfig.workerScript,
      ports.events,
      this.config.socketDir,
      managerConfig.bootstrap,
      ports.toolRelay,
      ports.inboundWait,
    );
    return slot.supervisor;
  }

  getStats(activeRuns: number): WorkerManagerStats {
    const slots = [...this.slots.values()];
    const running = slots.filter((slot) => slot.supervisor?.isActive() === true);
    return {
      workers: running.length,
      active: running.filter((slot) => slot.load > 0).length,
      idle: running.filter((slot) => slot.load === 0).length,
      ready: running.filter((slot) => slot.supervisor?.isReady() === true).length,
      activeRuns,
      maxActiveWorkers: this.config.maxActiveWorkers,
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

  async shutdown(): Promise<PromiseSettledResult<void>[]> {
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
    return results;
  }

  private async tryAcquireSlot(sessionId: string): Promise<WorkerSlot | undefined> {
    const affinityId = this.sessionAffinity.get(sessionId);
    const affinitySlot = affinityId === undefined ? undefined : this.slots.get(affinityId);
    if (affinitySlot !== undefined && affinitySlot.ownerSessionId === sessionId) {
      if (affinitySlot.load > 0 || affinitySlot.reserved) return undefined;
      affinitySlot.reserved = true;
      return affinitySlot;
    }

    if (this.slots.size < this.config.maxActiveWorkers) {
      const slot = this.createSlot(sessionId);
      this.sessionAffinity.set(sessionId, slot.id);
      return slot;
    }

    const reusable = this.findReusableIdleSlot();
    if (reusable) return this.reassignSlot(reusable, sessionId);
    return undefined;
  }

  private waitForSlot(): Promise<void> {
    if (this.waiters.length >= this.config.maxQueuedDeliveries) {
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
            message: `worker slot wait timed out after ${this.config.slotWaitTimeoutMs}ms`,
            code: "slot_wait_timeout",
          }),
        );
      }, this.config.slotWaitTimeoutMs);
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
    if (this.config.idleShutdownMs < 0) return;

    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = null;
      if (this.config.isStopping() || slot.load > 0) return;
      slot.reserved = true;
      this.shutdownIdleSlot(slot).catch(() => {
        slot.reserved = false;
        this.releaseOneWaiter();
      });
    }, this.config.idleShutdownMs);
  }

  private async shutdownIdleSlot(slot: WorkerSlot): Promise<void> {
    if (this.config.isStopping() || slot.load > 0) {
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
