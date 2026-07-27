export type RecoveryResult = {
  recovered: number;
  sessions: string[];
};

export interface InterruptedRunProjection {
  readonly sessionId: string;
  readonly runId: string;
}

export interface RunRecoveryService {
  readonly queries: {
    interruptedRuns(): Promise<readonly InterruptedRunProjection[]>;
  };
  readonly commands: {
    interruptRun(input: {
      readonly sessionId: string;
      readonly runId: string;
      readonly requestId: string;
      readonly reason: string;
    }): Promise<"recovered" | "unchanged">;
  };
}

export async function recoverInterruptedRuns(service: RunRecoveryService): Promise<RecoveryResult> {
  const interrupted = await service.queries.interruptedRuns();
  const sessions = new Set<string>();
  let recovered = 0;

  for (const run of interrupted) {
    const result = await service.commands.interruptRun({
      sessionId: run.sessionId,
      runId: run.runId,
      requestId: `run-recovery:${run.runId}`,
      reason: "coordinator restarted: run interrupted",
    });
    if (result === "recovered") {
      recovered += 1;
      sessions.add(run.sessionId);
    }
  }

  return { recovered, sessions: [...sessions] };
}
