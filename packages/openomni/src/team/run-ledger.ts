import type { PlanStep } from "@openomni/protocol";
import type { Team } from "@openomni/protocol";

type StepState = Team.StepState;

interface RunLedgerEntry {
  stepId: string;
  state: StepState;
  attempts: number;
  rejectionStreak: number;
  totalRejections: number;
  startedAt?: Date;
  completedAt?: Date;
}

const VALID_TRANSITIONS: Record<StepState, StepState[]> = {
  ready: ["running"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
  skipped: [],
};

const COMPLETED_STATES: StepState[] = ["succeeded", "failed", "skipped"];

function cloneEntry(entry: RunLedgerEntry): RunLedgerEntry {
  return {
    ...entry,
    startedAt: entry.startedAt ? new Date(entry.startedAt.getTime()) : undefined,
    completedAt: entry.completedAt
      ? new Date(entry.completedAt.getTime())
      : undefined,
  };
}

function getEntryOrThrow(
  entries: Map<string, RunLedgerEntry>,
  stepId: string,
): RunLedgerEntry {
  const entry = entries.get(stepId);
  if (!entry) {
    throw new Error(`Step not found: "${stepId}"`);
  }
  return entry;
}

export interface RunLedgerInstance {
  transition(stepId: string, state: StepState): void;
  recordAttempt(stepId: string): void;
  recordRejection(stepId: string): void;
  resetRejectionStreak(stepId: string): void;
  getState(): Map<string, RunLedgerEntry>;
  getStepState(stepId: string): RunLedgerEntry | undefined;
  getRunning(): RunLedgerEntry[];
  getCompleted(): RunLedgerEntry[];
}

export namespace RunLedger {
  export function create(steps: PlanStep[]): RunLedgerInstance {
    const entries = new Map<string, RunLedgerEntry>();

    for (const step of steps) {
      entries.set(step.stepId, {
        stepId: step.stepId,
        state: "ready",
        attempts: 0,
        rejectionStreak: 0,
        totalRejections: 0,
      });
    }

    return {
      transition(stepId: string, targetState: StepState): void {
        const entry = getEntryOrThrow(entries, stepId);

        if (targetState === "skipped") {
          entry.state = "skipped";
          entry.completedAt = new Date();
          return;
        }

        const allowed = VALID_TRANSITIONS[entry.state];
        if (!allowed.includes(targetState)) {
          throw new Error(
            `Invalid transition: "${entry.state}" → "${targetState}" for step "${stepId}"`,
          );
        }

        entry.state = targetState;

        if (targetState === "running") {
          entry.startedAt = new Date();
        }

        if (targetState === "succeeded" || targetState === "failed") {
          entry.completedAt = new Date();
        }
      },

      recordAttempt(stepId: string): void {
        const entry = getEntryOrThrow(entries, stepId);
        entry.attempts++;
      },

      recordRejection(stepId: string): void {
        const entry = getEntryOrThrow(entries, stepId);
        entry.rejectionStreak++;
        entry.totalRejections++;
      },

      resetRejectionStreak(stepId: string): void {
        const entry = getEntryOrThrow(entries, stepId);
        entry.rejectionStreak = 0;
      },

      getState(): Map<string, RunLedgerEntry> {
        const copy = new Map<string, RunLedgerEntry>();
        for (const [id, entry] of entries) {
          copy.set(id, cloneEntry(entry));
        }
        return copy;
      },

      getStepState(stepId: string): RunLedgerEntry | undefined {
        const entry = entries.get(stepId);
        return entry ? cloneEntry(entry) : undefined;
      },

      getRunning(): RunLedgerEntry[] {
        const result: RunLedgerEntry[] = [];
        for (const entry of entries.values()) {
          if (entry.state === "running") {
            result.push(cloneEntry(entry));
          }
        }
        return result;
      },

      getCompleted(): RunLedgerEntry[] {
        const result: RunLedgerEntry[] = [];
        for (const entry of entries.values()) {
          if (COMPLETED_STATES.includes(entry.state)) {
            result.push(cloneEntry(entry));
          }
        }
        return result;
      },
    };
  }
}
