import { TaskManager } from "./manager";
import { TaskStorage } from "./storage";

export interface Checkpoint {
  step: number;
  data: unknown;
  timestamp: number;
  runId: string;
}

export namespace CheckpointManager {
  export function save(runId: string, step: number, data: unknown): void {
    const run = TaskManager.getRun(runId);
    if (!run) {
      throw new Error(`TaskRun not found: ${runId}`);
    }

    const timestamp = Date.now();
    const checkpoint: Checkpoint = {
      step,
      data,
      timestamp,
      runId,
    };

    const updatedRun = {
      ...run,
      checkpoints: [...(run.checkpoints ?? []), checkpoint],
    };

    const store = TaskStorage.getAdapter();
    store.run.set(run.taskId, updatedRun);
  }

  export function get(runId: string): Checkpoint | undefined {
    const run = TaskManager.getRun(runId);
    if (!run?.checkpoints?.length) {
      return undefined;
    }

    return run.checkpoints[run.checkpoints.length - 1] as Checkpoint;
  }

  export function list(runId: string): Checkpoint[] {
    const run = TaskManager.getRun(runId);
    return (run?.checkpoints ?? []) as Checkpoint[];
  }
}
