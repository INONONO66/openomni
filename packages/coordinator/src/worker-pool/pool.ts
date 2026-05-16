import {
  createWorkerManager,
  type ToolCallParams,
  type ToolCallResult,
  type WorkerManager,
  type WorkerManagerStats,
} from "../worker-manager";
import type { WorkerManagerConfig } from "../worker-manager";

export type { ToolCallParams, ToolCallResult };

export type WorkerPoolConfig = Omit<WorkerManagerConfig, "maxActiveWorkers"> & {
  /** @deprecated ADR-008 treats this as the maximum number of active on-demand workers. */
  size?: number;
  maxActiveWorkers?: number;
};

export type WorkerPoolStats = WorkerManagerStats;

export type WorkerPool = WorkerManager;

export function createWorkerPool(config: WorkerPoolConfig): WorkerPool {
  return createWorkerManager({
    ...config,
    maxActiveWorkers: config.maxActiveWorkers ?? config.size,
  });
}
