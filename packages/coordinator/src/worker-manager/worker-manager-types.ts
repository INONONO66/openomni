import type { BusEvent, TraceContext, WorkerBootstrap } from "@openomni/protocol";
import type {
  InboundWaitParams,
  InboundWaitResult,
  ToolCallContext as SupervisorToolCallContext,
  ToolCallParams,
  ToolCallResult,
  WorkerSupervisor,
} from "../worker-supervision/supervisor";

export const DEFAULT_MAX_ACTIVE_WORKERS = 10;
export const HARD_MAX_ACTIVE_WORKERS = 10;
export const DEFAULT_IDLE_SHUTDOWN_MS = 600_000;
export const DEFAULT_SLOT_WAIT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_QUEUED_DELIVERIES = 100;

export type { ToolCallParams, ToolCallResult };
export type { InboundWaitParams, InboundWaitResult };

export type ToolCallContext = SupervisorToolCallContext & {
  readonly traceContext?: TraceContext.Type;
};

/**
 * Factory-private pool construction config (#553 C9): not exported from the
 * package barrel. External callers pass an object literal to
 * `createWorkerManager`; `slotWaitTimeoutMs`/`maxQueuedDeliveries` are
 * pool-internal knobs exercised only by the coordinator's own tests.
 */
export type WorkerManagerConfig = {
  workerScript: string;
  socketDir?: string;
  maxActiveWorkers?: number;
  idleShutdownMs?: number;
  slotWaitTimeoutMs?: number;
  maxQueuedDeliveries?: number;
  bootstrap?: WorkerBootstrap.Bootstrap;
  /**
   * Extra env keys forwarded to spawned workers on top of the production
   * allowlist (see `buildWorkerEnv`). A test seam — fixtures pass their
   * OPENOMNI_WORKER_* knobs here explicitly.
   */
  extraWorkerEnvKeys?: readonly string[];
};

/**
 * Environment ports injected by the composition root (#462 §2). The driver
 * owns process physics only; every edge to the rest of the system comes in
 * through here — the ledger event edge via `events`, tool execution via
 * `toolRelay` (the dispatcher, ring 4), and the resident question bridge
 * via `inboundWait`. Tests bind a collector sink instead of the Bus.
 * Factory-private (#553 C9): callers pass a literal; only the port
 * param/result types are public.
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
 * Exactly the six driver-shaped methods (#553 C9); the test-only chaos
 * hook lives on the pool class behind `killWorkerForTest`.
 */
export type WorkerManager = {
  deliver(runId: string, task: DeliverTask): Promise<unknown>;
  cancel(runId: string): Promise<unknown>;
  send(sessionId: string, message: string, traceId: string, runId?: string): Promise<unknown>;
  stats(): WorkerManagerStats;
  waitUntilReady(timeoutMs?: number): Promise<void>;
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
  readonly runId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly agentName?: string;
  slot?: WorkerSlot;
  cancelled?: boolean;
};

export type SlotWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};
