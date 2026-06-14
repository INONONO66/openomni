import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Operational, type WorkerBootstrap } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { createSessionRouting, type SessionRouter } from "../worker-supervision/session-routing";
import {
  WorkerSupervisor,
  type InboundWaitParams,
  type InboundWaitResult,
  type ToolCallCancelParams,
  type ToolCallContext,
  type ToolCallParams,
  type ToolCallResult,
} from "../worker-supervision/supervisor";

const DEFAULT_MAX_ACTIVE_WORKERS = 10;
const HARD_MAX_ACTIVE_WORKERS = 10;
const DEFAULT_IDLE_SHUTDOWN_MS = 600_000;
const DEFAULT_SLOT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_QUEUED_DISPATCHES = 100;

export type { ToolCallCancelParams, ToolCallContext, ToolCallParams, ToolCallResult };
export type { InboundWaitParams, InboundWaitResult };

export type WorkerManagerConfig = {
  workerScript: string;
  socketDir?: string;
  maxActiveWorkers?: number;
  idleShutdownMs?: number;
  slotWaitTimeoutMs?: number;
  maxQueuedDispatches?: number;
  bootstrap?: WorkerBootstrap.Bootstrap;
  onToolCall?: (params: ToolCallParams, context?: ToolCallContext) => Promise<ToolCallResult>;
  onInboundWait?: (params: InboundWaitParams) => Promise<InboundWaitResult>;
  onWorkerSnapshot?: (workerId: number, snapshot: WorkerBootstrap.WorkerSnapshot) => void;
};

export type WorkerManagerStats = {
  workers: number;
  active: number;
  idle: number;
  ready: number;
  activeRuns: number;
  maxActiveWorkers: number;
};

export type WorkerManager = {
  dispatch(sessionId: string, runId: string, params: Record<string, unknown>): Promise<unknown>;
  cancelRun(runId: string): Promise<unknown>;
  deliverMessage(sessionId: string, message: string, runId?: string): Promise<unknown>;
  getStats(): WorkerManagerStats;
  waitUntilReady(timeoutMs?: number): Promise<void>;
  killWorker(index: number): void;
  shutdown(): Promise<void>;
};

type WorkerSlot = {
  readonly id: number;
  ownerSessionId: string;
  supervisor: WorkerSupervisor | null;
  load: number;
  reserved: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

type ActiveRun = {
  sessionId: string;
  slot?: WorkerSlot;
  cancelled?: boolean;
};

type SlotWaiter = { resolve: () => void; reject: (error: Error) => void };

export function createWorkerManager(config: WorkerManagerConfig): WorkerManager {
  return new OnDemandWorkerManager(config);
}

export class OnDemandWorkerManager implements WorkerManager {
  private readonly socketDir: string;
  private readonly maxActiveWorkers: number;
  private readonly idleShutdownMs: number;
  private readonly slotWaitTimeoutMs: number;
  private readonly maxQueuedDispatches: number;
  private readonly slots = new Map<number, WorkerSlot>();
  private readonly sessionRouting: SessionRouter = createSessionRouting();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly waiters: SlotWaiter[] = [];
  private nextWorkerId = 0;
  private stopping = false;

  constructor(private readonly config: WorkerManagerConfig) {
    this.socketDir = createPrivateSocketDir(config.socketDir ?? "/tmp");
    this.maxActiveWorkers = normalizeMaxActiveWorkers(config.maxActiveWorkers);
    this.idleShutdownMs = config.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    this.slotWaitTimeoutMs = config.slotWaitTimeoutMs ?? DEFAULT_SLOT_WAIT_TIMEOUT_MS;
    this.maxQueuedDispatches = config.maxQueuedDispatches ?? DEFAULT_MAX_QUEUED_DISPATCHES;
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
      slot = await this.acquireSlot(sessionId);
    } catch (error) {
      this.activeRuns.delete(runId);
      throw error;
    }
    activeRun.slot = slot;
    if (activeRun.cancelled) {
      this.activeRuns.delete(runId);
      slot.reserved = false;
      if (slot.load === 0) {
        this.releaseOneWaiter();
        this.scheduleIdleShutdown(slot);
      }
      return {
        runId,
        sessionId,
        status: "cancelled",
        error: "cancelled before worker delivery",
      };
    }
    slot.load += 1;
    slot.reserved = false;
    this.clearIdleTimer(slot);

    try {
      const supervisor = this.ensureSupervisor(slot);
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
      const wasLoaded = slot.load > 0;
      if (wasLoaded) slot.load -= 1;
      if (wasLoaded && slot.load === 0) {
        this.releaseOneWaiter();
        this.scheduleIdleShutdown(slot);
      }
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
    supervisor?.forceKill();
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
    this.sessionRouting.clear();
    this.activeRuns.clear();
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new Error("worker manager is shutting down"));
    }
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

  private async acquireSlot(sessionId: string): Promise<WorkerSlot> {
    while (!this.stopping) {
      const slot = await this.tryAcquireSlot(sessionId);
      if (slot) return slot;
      await this.waitForSlot();
    }
    throw new Error("worker manager is shutting down");
  }

  private async tryAcquireSlot(sessionId: string): Promise<WorkerSlot | undefined> {
    const affinityId = this.sessionRouting.get(sessionId);
    const affinitySlot = affinityId === undefined ? undefined : this.slots.get(affinityId);
    if (affinitySlot !== undefined && affinitySlot.ownerSessionId === sessionId) {
      if (affinitySlot.load > 0 || affinitySlot.reserved) return undefined;
      affinitySlot.reserved = true;
      return affinitySlot;
    }

    if (this.slots.size < this.maxActiveWorkers) {
      const slot = this.createSlot(sessionId);
      this.sessionRouting.assign(sessionId, slot.id);
      return slot;
    }

    const reusable = this.findReusableIdleSlot();
    if (reusable) return this.reassignSlot(reusable, sessionId);
    return undefined;
  }

  private waitForSlot(): Promise<void> {
    if (this.waiters.length >= this.maxQueuedDispatches) {
      return Promise.reject(new Error("worker manager dispatch queue is full"));
    }
    return new Promise((resolve, reject) => {
      const waiter = {} as SlotWaiter;
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`worker manager slot wait timed out after ${this.slotWaitTimeoutMs}ms`));
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
    this.sessionRouting.forgetWorker(slot.id);
    const supervisor = slot.supervisor;
    slot.supervisor = null;
    await supervisor?.stop();
    slot.ownerSessionId = sessionId;
    this.sessionRouting.assign(sessionId, slot.id);
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

  private ensureSupervisor(slot: WorkerSlot): WorkerSupervisor {
    if (slot.supervisor?.isActive() === true) return slot.supervisor;

    slot.supervisor = new WorkerSupervisor(
      slot.id,
      this.config.workerScript,
      this.socketDir,
      this.config.bootstrap,
      this.config.onToolCall,
      this.config.onWorkerSnapshot,
      this.config.onInboundWait,
    );
    return slot.supervisor;
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
    this.sessionRouting.forgetWorker(slot.id);
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

function createPrivateSocketDir(baseDir: string): string {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  cleanupStaleSocketDirs(baseDir);
  const dir = fs.mkdtempSync(path.join(baseDir, "openomni-workers-"));
  fs.chmodSync(dir, 0o700);
  return dir;
}

const SOCKET_PROBE_TIMEOUT_MS = 1000;

function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = net.createConnection(socketPath);
    conn.setTimeout(SOCKET_PROBE_TIMEOUT_MS);
    conn.once("connect", () => {
      conn.destroy();
      resolve(true);
    });
    conn.once("error", () => {
      conn.destroy();
      resolve(false);
    });
    conn.once("timeout", () => {
      conn.destroy();
      resolve(false);
    });
  });
}

function warnCleanup(msg: string, context: Record<string, unknown>): void {
  Bus.publish(Operational.Warn, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "coordinator.worker-manager",
    msg,
    context,
  });
}

function cleanupStaleSocketDirs(baseDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(baseDir);
  } catch (err) {
    warnCleanup("failed to read socket base directory", {
      baseDir,
      error: String(err),
    });
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith("openomni-workers-")) continue;
    const dirPath = path.join(baseDir, entry);
    try {
      if (!fs.lstatSync(dirPath).isDirectory()) continue;
    } catch (err) {
      warnCleanup("failed to stat worker directory during cleanup", {
        dirPath,
        error: String(err),
      });
      continue;
    }

    void cleanupIfStale(dirPath);
  }
}

async function cleanupIfStale(dirPath: string): Promise<void> {
  try {
    await cleanupIfStaleUnsafe(dirPath);
  } catch (err) {
    warnCleanup("stale worker directory cleanup failed", {
      dirPath,
      error: String(err),
    });
  }
}

async function cleanupIfStaleUnsafe(dirPath: string): Promise<void> {
  const files = fs.readdirSync(dirPath);
  const sockets = files.filter((f) => f.endsWith(".sock"));

  if (sockets.length === 0) return;

  const results = await Promise.all(sockets.map((sock) => isSocketAlive(path.join(dirPath, sock))));
  if (results.some(Boolean)) return;

  fs.rmSync(dirPath, { recursive: true, force: true });
}
