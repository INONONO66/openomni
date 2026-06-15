import type { WorkerBootstrap } from "@openomni/protocol";
import type {
  InboundWaitParams,
  InboundWaitResult,
  ToolCallCancelParams,
  ToolCallContext,
  ToolCallParams,
  ToolCallResult,
  WorkerSupervisor,
} from "../worker-supervision/supervisor";

export const DEFAULT_MAX_ACTIVE_WORKERS = 10;
export const HARD_MAX_ACTIVE_WORKERS = 10;
export const DEFAULT_IDLE_SHUTDOWN_MS = 600_000;
export const DEFAULT_SLOT_WAIT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_QUEUED_DISPATCHES = 100;

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

export type WorkerSlot = {
  readonly id: number;
  ownerSessionId: string;
  supervisor: WorkerSupervisor | null;
  load: number;
  reserved: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

export type ActiveRun = {
  sessionId: string;
  slot?: WorkerSlot;
  cancelled?: boolean;
};

export type SlotWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};
