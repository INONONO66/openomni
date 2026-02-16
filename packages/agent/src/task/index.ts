// Task domain — lifecycle, storage, triggers

import { Task } from "./types";
export { Task };
/** @deprecated Use Task.Run */
export const TaskRun = Task.Run;
/** @deprecated Use Task.Run */
export type TaskRun = Task.Run;
/** @deprecated Use Task.TriggerSignal */
export const TriggerSignal = Task.TriggerSignal;
/** @deprecated Use Task.TriggerSignal */
export type TriggerSignal = Task.TriggerSignal;
export { TaskStatusManager, TaskStateMachine } from "./lifecycle";
export { CheckpointManager, type Checkpoint } from "./lifecycle";
export {
  CrashRecovery,
  type RecoveryAction,
  type RecoveryResult,
} from "./lifecycle";
export {
  type TaskStore,
  type TaskListFilter,
  type RunListOptions,
  InMemoryTaskStore,
  TaskStorage,
} from "./storage";
export { FileTaskStore } from "./storage";
export { TaskManager } from "./manager";
export type { TriggerError, TriggerResult } from "./trigger-engine";
export { PolicyError } from "./manager";
