import fs from "node:fs";
import { createPrivateSocketDir } from "./worker-socket-dir";
import { WorkerSlotCoordinator } from "./worker-slot-coordinator";
import {
  DEFAULT_IDLE_SHUTDOWN_MS,
  DEFAULT_MAX_ACTIVE_WORKERS,
  DEFAULT_MAX_QUEUED_DISPATCHES,
  DEFAULT_SLOT_WAIT_TIMEOUT_MS,
  HARD_MAX_ACTIVE_WORKERS,
  type ActiveRun,
  type WorkerManager,
  type WorkerManagerConfig,
  type WorkerManagerStats,
  type WorkerPorts,
  type WorkerSlot,
} from "./worker-manager-types";

export type {
  InboundWaitParams,
  InboundWaitResult,
  ToolCallCancelParams,
  ToolCallContext,
  ToolCallParams,
  ToolCallResult,
  WorkerManager,
  WorkerManagerConfig,
  WorkerManagerStats,
  WorkerPorts,
} from "./worker-manager-types";

export function createWorkerManager(
  config: WorkerManagerConfig,
  ports: WorkerPorts,
): WorkerManager {
  return new OnDemandWorkerManager(config, ports);
}

export class OnDemandWorkerManager implements WorkerManager {
  private readonly socketDir: string;
  private readonly maxActiveWorkers: number;
  private readonly idleShutdownMs: number;
  private readonly slotWaitTimeoutMs: number;
  private readonly maxQueuedDispatches: number;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly slotCoordinator: WorkerSlotCoordinator;
  private stopping = false;

  constructor(config: WorkerManagerConfig, ports: WorkerPorts) {
    this.socketDir = createPrivateSocketDir(config.socketDir ?? "/tmp", ports.events);
    this.maxActiveWorkers = normalizeMaxActiveWorkers(config.maxActiveWorkers);
    this.idleShutdownMs = config.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    this.slotWaitTimeoutMs = config.slotWaitTimeoutMs ?? DEFAULT_SLOT_WAIT_TIMEOUT_MS;
    this.maxQueuedDispatches = config.maxQueuedDispatches ?? DEFAULT_MAX_QUEUED_DISPATCHES;
    this.slotCoordinator = new WorkerSlotCoordinator({
      managerConfig: config,
      ports,
      socketDir: this.socketDir,
      maxActiveWorkers: this.maxActiveWorkers,
      idleShutdownMs: this.idleShutdownMs,
      slotWaitTimeoutMs: this.slotWaitTimeoutMs,
      maxQueuedDispatches: this.maxQueuedDispatches,
      isStopping: () => this.stopping,
    });
  }

  async dispatch(
    sessionId: string,
    runId: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.stopping) {
      throw new Error("worker manager is shutting down");
    }
    if (this.activeRuns.has(runId)) {
      throw new Error(`run already active: ${runId}`);
    }

    const activeRun: ActiveRun = { sessionId };
    this.activeRuns.set(runId, activeRun);
    let slot: WorkerSlot;
    try {
      slot = await this.slotCoordinator.acquireSlot(sessionId);
    } catch (error) {
      this.activeRuns.delete(runId);
      throw error;
    }
    activeRun.slot = slot;
    if (activeRun.cancelled) {
      this.activeRuns.delete(runId);
      this.slotCoordinator.releaseReservedSlot(slot);
      return {
        runId,
        sessionId,
        status: "cancelled",
        error: "cancelled before worker delivery",
      };
    }
    this.slotCoordinator.markSlotLoaded(slot);

    try {
      const supervisor = this.slotCoordinator.ensureSupervisor(slot);
      const generation = supervisor.getGeneration();
      await supervisor.waitReady();
      if (supervisor.getGeneration() !== generation) {
        throw new Error(`worker ${slot.id} restarted before run ${runId} was delivered`);
      }
      if (activeRun.cancelled) {
        return {
          runId,
          sessionId,
          status: "cancelled",
          error: "cancelled before worker delivery",
        };
      }
      return await supervisor.dispatch(runId, { sessionId, ...params });
    } finally {
      this.activeRuns.delete(runId);
      this.slotCoordinator.releaseLoadedSlot(slot);
    }
  }

  async cancelRun(runId: string): Promise<unknown> {
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

  async deliverMessage(sessionId: string, message: string, runId?: string): Promise<unknown> {
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
    return supervisor.deliverMessage(sessionId, message, runId ?? activeRunId);
  }

  getStats(): WorkerManagerStats {
    return this.slotCoordinator.getStats(this.activeRuns.size);
  }

  async waitUntilReady(timeoutMs = 15_000): Promise<void> {
    await this.slotCoordinator.waitUntilReady(timeoutMs);
  }

  killWorker(index: number): void {
    this.slotCoordinator.killWorker(index);
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const results = await this.slotCoordinator.shutdown();
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
}

function normalizeMaxActiveWorkers(value: number | undefined): number {
  const requested = value ?? DEFAULT_MAX_ACTIVE_WORKERS;
  if (!Number.isFinite(requested) || requested < 1) return DEFAULT_MAX_ACTIVE_WORKERS;
  return Math.min(Math.floor(requested), HARD_MAX_ACTIVE_WORKERS);
}
