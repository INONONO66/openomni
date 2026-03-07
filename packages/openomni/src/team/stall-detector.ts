import type { Team } from "@openomni/protocol";
import type { RunLedgerInstance } from "./run-ledger";
import type { DAGStructure } from "../dag/index";

const NOT_STALLED: StallDetector.StallResult = { stalled: false };

const TERMINAL_STATES: Team.StepState[] = ["succeeded", "failed", "skipped"];
const FAILED_STATES: Team.StepState[] = ["failed", "skipped"];

export namespace StallDetector {
  export interface StallConfig {
    maxConsecutiveRejections: number;
    maxNoProgressTurns: number;
  }

  export interface StallResult {
    stalled: boolean;
    reason?: Team.StallReason;
    details?: string;
    stalledStepId?: string;
  }

  export function checkConsecutiveRejections(
    ledger: RunLedgerInstance,
    config: StallConfig,
  ): StallResult {
    for (const [, entry] of ledger.getState()) {
      if (entry.rejectionStreak >= config.maxConsecutiveRejections) {
        return {
          stalled: true,
          reason: "consecutive_rejections",
          details: `Step "${entry.stepId}" rejected ${entry.rejectionStreak} consecutive times (limit: ${config.maxConsecutiveRejections})`,
          stalledStepId: entry.stepId,
        };
      }
    }
    return NOT_STALLED;
  }

  export function checkNoProgress(
    ledger: RunLedgerInstance,
    _dag: DAGStructure,
    config: StallConfig,
    noProgressTurns: number,
  ): StallResult {
    if (noProgressTurns < config.maxNoProgressTurns) {
      return NOT_STALLED;
    }

    if (ledger.getRunning().length > 0) {
      return NOT_STALLED;
    }

    return {
      stalled: true,
      reason: "no_progress",
      details: `No progress for ${noProgressTurns} turns (limit: ${config.maxNoProgressTurns}) and no steps running`,
    };
  }

  export function checkUnsatisfiableDeps(
    ledger: RunLedgerInstance,
    dag: DAGStructure,
  ): StallResult {
    const state = ledger.getState();

    for (const [stepId, entry] of state) {
      if (TERMINAL_STATES.includes(entry.state) || entry.state === "running") {
        continue;
      }

      const deps = dag.edges.get(stepId);
      if (!deps || deps.size === 0) {
        continue;
      }

      for (const depId of deps) {
        const depEntry = state.get(depId);
        if (depEntry && FAILED_STATES.includes(depEntry.state)) {
          return {
            stalled: true,
            reason: "unsatisfiable_deps",
            details: `Step "${stepId}" depends on "${depId}" which is "${depEntry.state}"`,
            stalledStepId: stepId,
          };
        }
      }
    }

    return NOT_STALLED;
  }

  export function check(
    ledger: RunLedgerInstance,
    dag: DAGStructure,
    config: StallConfig,
    noProgressTurns: number,
  ): StallResult {
    const rejections = checkConsecutiveRejections(ledger, config);
    if (rejections.stalled) return rejections;

    const unsatisfiable = checkUnsatisfiableDeps(ledger, dag);
    if (unsatisfiable.stalled) return unsatisfiable;

    const noProgress = checkNoProgress(ledger, dag, config, noProgressTurns);
    if (noProgress.stalled) return noProgress;

    return NOT_STALLED;
  }
}
