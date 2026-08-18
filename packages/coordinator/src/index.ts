// Public surface (#553 C9, trimmed by the #audit dead-surface pass): the
// Execution.Driver-shaped delivery core — deliver/cancel/send/stats/
// waitUntilReady/shutdown — plus the port param/result types apps/server
// actually imports. `DeliverTask`/`ToolCallParams`/`ToolCallResult`/
// `WorkerManagerStats` had zero external importers and are package-internal
// now; pool construction knobs (`WorkerManagerConfig`/`WorkerPorts`) stay
// factory-private and worker-supervision never leaves the package.
export { createWorkerManager } from "./worker-manager";
export type {
  InboundWaitParams,
  InboundWaitResult,
  ToolCallContext,
  WorkerManager,
} from "./worker-manager";
// #500 C3: the deliver-verb rejection taxonomy lives with its throwers now;
// apps/server (composition root) catches it through this export.
export { WorkerDeliveryError } from "./error";
