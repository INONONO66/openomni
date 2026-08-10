// Public surface (#553 C9): the Execution.Driver-shaped delivery core —
// deliver/cancel/send/stats/waitUntilReady/shutdown — plus its parameter and
// result types. Pool construction knobs (`WorkerManagerConfig`/`WorkerPorts`)
// are factory-private; worker-supervision never leaves the package.
export { createWorkerManager } from "./worker-manager";
export type {
  DeliverTask,
  InboundWaitParams,
  InboundWaitResult,
  ToolCallContext,
  ToolCallParams,
  ToolCallResult,
  WorkerManager,
  WorkerManagerStats,
} from "./worker-manager";
