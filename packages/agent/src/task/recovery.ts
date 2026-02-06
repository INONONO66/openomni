import { TaskManager } from "./manager";
import { CheckpointManager } from "./checkpoint";
import { Session } from "@openomni/session";

// ============================================================
// Types
// ============================================================

export type RecoveryAction = "resume" | "restart" | "fail";

export interface RecoveryResult {
  runId: string;
  action: RecoveryAction;
  success: boolean;
  error?: string;
}

// ============================================================
// CrashRecovery
// ============================================================

export namespace CrashRecovery {
  export function scan(): string[] {
    const orphanedRuns = TaskManager.listRunsByStatus(["running", "blocked"]);
    return orphanedRuns.map((run) => run.runId);
  }

  /**
   * Decision matrix:
   * - session + checkpoint → resume from checkpoint
   * - session only → restart
   * - checkpoint only → new session + resume
   * - neither → mark failed
   */
  export async function recover(runId: string): Promise<RecoveryResult> {
    const run = TaskManager.getRun(runId);

    if (!run) {
      return {
        runId,
        action: "fail",
        success: false,
        error: `TaskRun not found: ${runId}`,
      };
    }

    const sessionKey = run.sessionKey;
    const hasSession = Session.get(sessionKey) !== undefined;
    const checkpoint = CheckpointManager.get(runId);
    const hasCheckpoint = checkpoint !== undefined;

    try {
      if (hasSession && hasCheckpoint) {
        TaskManager.setRunStatus(runId, "running", "crash_recovery:resume");
        return { runId, action: "resume", success: true };
      }

      if (hasSession && !hasCheckpoint) {
        TaskManager.setRunStatus(runId, "scheduled", "crash_recovery:restart");
        return { runId, action: "restart", success: true };
      }

      if (!hasSession && hasCheckpoint) {
        Session.create({
          title: `recovery:${run.taskId}:${runId}`,
          model: { providerID: "recovery", modelID: "recovery" },
        });
        TaskManager.setRunStatus(runId, "running", "crash_recovery:resume");
        return { runId, action: "resume", success: true };
      }

      TaskManager.setRunStatus(runId, "failed", "crash_recovery:no_state");
      return {
        runId,
        action: "fail",
        success: true,
        error: "No session or checkpoint found for recovery",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      try {
        TaskManager.setRunStatus(runId, "failed", `crash_recovery:error`);
      } catch {
        /* best-effort */
      }

      return {
        runId,
        action: "fail",
        success: false,
        error: `Recovery failed: ${message}`,
      };
    }
  }

  export async function startupRecovery(): Promise<RecoveryResult[]> {
    const orphanedRunIds = scan();
    const results: RecoveryResult[] = [];

    for (const runId of orphanedRunIds) {
      const result = await recover(runId);
      results.push(result);
    }

    return results;
  }
}
