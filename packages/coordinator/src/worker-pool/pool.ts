import {
  createWorkerManager,
  type ToolCallCancelParams,
  type ToolCallContext,
  type ToolCallParams,
  type ToolCallResult,
  type WorkerManager,
  type WorkerManagerStats,
} from "../worker-manager";
import type { WorkerManagerConfig } from "../worker-manager";

export type { ToolCallCancelParams, ToolCallContext, ToolCallParams, ToolCallResult };

export type WorkerPoolConfig = Omit<WorkerManagerConfig, "maxActiveWorkers"> & {
  /** Legacy alias for maxActiveWorkers. */
  size?: number;
  maxActiveWorkers?: number;
};

export type WorkerPoolStats = WorkerManagerStats;

export type WorkerPool = WorkerManager;

export function createWorkerPool(config: WorkerPoolConfig): WorkerPool {
  const { size: _size, ...managerConfig } = config;
  return createWorkerManager({
    ...managerConfig,
    maxActiveWorkers: config.maxActiveWorkers ?? config.size ?? 8,
  });
}
