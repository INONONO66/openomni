import { TaskManager } from "../manager";
import { TaskStorage } from "../storage";

export interface Checkpoint {
  step: string;
  data: Record<string, unknown>;
  savedAt: number;
}

export namespace CheckpointManager {
  export function save(
    runId: string,
    checkpoint: Omit<Checkpoint, "savedAt">,
  ): boolean {
    const run = TaskManager.getRun(runId);
    if (!run) {
      return false;
    }

    const nextCheckpoint: Checkpoint = {
      step: checkpoint.step,
      data: checkpoint.data,
      savedAt: Date.now(),
    };

    const updatedRun = {
      ...run,
      checkpoint: nextCheckpoint,
    };

    const store = TaskStorage.getAdapter();
    store.run.set(run.taskId, updatedRun);
    return true;
  }

  export function get(runId: string): Checkpoint | undefined {
    const run = TaskManager.getRun(runId);
    return run?.checkpoint as Checkpoint | undefined;
  }

  export function list(runId: string): Checkpoint[] {
    const checkpoint = get(runId);
    return checkpoint ? [checkpoint] : [];
  }
}
