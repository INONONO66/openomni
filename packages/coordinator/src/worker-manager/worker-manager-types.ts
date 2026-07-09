import type { BusEvent, WorkerBootstrap } from "@openomni/protocol";
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
export const DEFAULT_MAX_QUEUED_DELIVERIES = 100;

export type { ToolCallCancelParams, ToolCallContext, ToolCallParams, ToolCallResult };
export type { InboundWaitParams, InboundWaitResult };

export type WorkerManagerConfig = {
  workerScript: string;
  socketDir?: string;
  maxActiveWorkers?: number;
  idleShutdownMs?: number;
  slotWaitTimeoutMs?: number;
  maxQueuedDeliveries?: number;
  bootstrap?: WorkerBootstrap.Bootstrap;
};

/**
 * Environment ports injected by the composition root (#462 §2). The driver
 * owns process physics only; every edge to the rest of the system comes in
 * through here — the ledger event edge via `events`, tool execution via
 * `toolRelay` (the dispatcher, ring 4), and the resident question bridge
 * via `inboundWait`. Tests bind a collector sink instead of the Bus.
 */
export type WorkerPorts = {
  events: BusEvent.Sink;
  toolRelay?: (params: ToolCallParams, context?: ToolCallContext) => Promise<ToolCallResult>;
  inboundWait?: (params: InboundWaitParams) => Promise<InboundWaitResult>;
};

export type WorkerManagerStats = {
  workers: number;
  active: number;
  idle: number;
  ready: number;
  activeRuns: number;
  maxActiveWorkers: number;
};

/**
 * A task handed to `deliver`. Already authorized and policy-stamped by
 * dispatch (ring 4) — the driver never evaluates policy. `sessionId` keys
 * slot affinity and is part of the payload the worker receives.
 */
export type DeliverTask = { sessionId: string } & Record<string, unknown>;

/**
 * Ring-2 process driver surface (#462 §1): one verb, no judgment.
 * Implements the command face of `Execution.Driver` in protocol.
 */
export type WorkerManager = {
  deliver(runId: string, task: DeliverTask): Promise<unknown>;
  cancel(runId: string): Promise<unknown>;
  send(sessionId: string, message: string, runId?: string): Promise<unknown>;
  stats(): WorkerManagerStats;
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
