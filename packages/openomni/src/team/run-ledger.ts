import type { PlanStep } from "@openomni/protocol";
import type { Team } from "@openomni/protocol";
import { Storage } from "@openomni/session";

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
  running: ["succeeded", "failed", "retrying", "handed_off"],
  succeeded: [],
  failed: [],
  skipped: [],
  retrying: ["running"],
  handed_off: ["running"],
};

const COMPLETED_STATES: StepState[] = ["succeeded", "failed", "skipped"];

const EVENT_TYPES = {
  TRANSITION: "ledger.transition",
  ATTEMPT: "ledger.attempt",
  REJECTION: "ledger.rejection",
  REJECTION_RESET: "ledger.rejection_reset",
} as const;

function cloneEntry(entry: RunLedgerEntry): RunLedgerEntry {
  return {
    ...entry,
    startedAt: entry.startedAt ? new Date(entry.startedAt.getTime()) : undefined,
    completedAt: entry.completedAt ? new Date(entry.completedAt.getTime()) : undefined,
  };
}

function getEntryOrThrow(entries: Map<string, RunLedgerEntry>, stepId: string): RunLedgerEntry {
  const entry = entries.get(stepId);
  if (!entry) {
    throw new Error(`Step not found: "${stepId}"`);
  }
  return entry;
}

function persistEvent(
  sessionId: string | undefined,
  type: string,
  payload: Record<string, unknown>,
): void {
  if (!sessionId) return;
  const adapter = Storage.get().eventLog;
  if (!adapter) return;
  adapter.append(sessionId, type, JSON.stringify(payload));
}

function buildInstance(
  entries: Map<string, RunLedgerEntry>,
  sessionId?: string,
): RunLedgerInstance {
  return {
    transition(stepId: string, targetState: StepState): void {
      const entry = getEntryOrThrow(entries, stepId);

      if (targetState === "skipped") {
        const from = entry.state;
        entry.state = "skipped";
        entry.completedAt = new Date();
        persistEvent(sessionId, EVENT_TYPES.TRANSITION, {
          stepId,
          from,
          to: "skipped",
          completedAt: entry.completedAt.toISOString(),
        });
        return;
      }

      const allowed = VALID_TRANSITIONS[entry.state];
      if (!allowed.includes(targetState)) {
        throw new Error(
          `Invalid transition: "${entry.state}" → "${targetState}" for step "${stepId}"`,
        );
      }

      const from = entry.state;
      entry.state = targetState;

      if (targetState === "running") {
        entry.startedAt = new Date();
      }

      if (targetState === "succeeded" || targetState === "failed") {
        entry.completedAt = new Date();
      }

      persistEvent(sessionId, EVENT_TYPES.TRANSITION, {
        stepId,
        from,
        to: targetState,
        ...(entry.startedAt && targetState === "running"
          ? { startedAt: entry.startedAt.toISOString() }
          : {}),
        ...(entry.completedAt && (targetState === "succeeded" || targetState === "failed")
          ? { completedAt: entry.completedAt.toISOString() }
          : {}),
      });
    },

    recordAttempt(stepId: string): void {
      const entry = getEntryOrThrow(entries, stepId);
      entry.attempts++;
      persistEvent(sessionId, EVENT_TYPES.ATTEMPT, { stepId });
    },

    recordRejection(stepId: string): void {
      const entry = getEntryOrThrow(entries, stepId);
      entry.rejectionStreak++;
      entry.totalRejections++;
      persistEvent(sessionId, EVENT_TYPES.REJECTION, { stepId });
    },

    resetRejectionStreak(stepId: string): void {
      const entry = getEntryOrThrow(entries, stepId);
      entry.rejectionStreak = 0;
      persistEvent(sessionId, EVENT_TYPES.REJECTION_RESET, { stepId });
    },

    getState(): Map<string, RunLedgerEntry> {
      return new Map([...entries].map(([id, entry]) => [id, cloneEntry(entry)]));
    },

    getStepState(stepId: string): RunLedgerEntry | undefined {
      const entry = entries.get(stepId);
      return entry ? cloneEntry(entry) : undefined;
    },

    getRunning(): RunLedgerEntry[] {
      return [...entries.values()].filter((e) => e.state === "running").map(cloneEntry);
    },

    getCompleted(): RunLedgerEntry[] {
      return [...entries.values()]
        .filter((e) => COMPLETED_STATES.includes(e.state))
        .map(cloneEntry);
    },
  };
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

interface CreateOptions {
  sessionId?: string;
}

export namespace RunLedger {
  export function create(steps: PlanStep[], options?: CreateOptions): RunLedgerInstance {
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

    return buildInstance(entries, options?.sessionId);
  }

  export function recover(sessionId: string, steps: PlanStep[]): RunLedgerInstance {
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

    const adapter = Storage.get().eventLog;
    if (adapter) {
      const rows = adapter.replay(sessionId);
      for (const row of rows) {
        const payload = JSON.parse(row.data) as Record<string, unknown>;
        const stepId = payload.stepId as string;
        const entry = entries.get(stepId);
        if (!entry) continue;

        switch (row.type) {
          case EVENT_TYPES.TRANSITION: {
            entry.state = payload.to as StepState;
            if (payload.startedAt) entry.startedAt = new Date(payload.startedAt as string);
            if (payload.completedAt) entry.completedAt = new Date(payload.completedAt as string);
            break;
          }
          case EVENT_TYPES.ATTEMPT:
            entry.attempts++;
            break;
          case EVENT_TYPES.REJECTION:
            entry.rejectionStreak++;
            entry.totalRejections++;
            break;
          case EVENT_TYPES.REJECTION_RESET:
            entry.rejectionStreak = 0;
            break;
        }
      }
    }

    // recovered instance continues persisting to the same sessionId
    return buildInstance(entries, sessionId);
  }
}
