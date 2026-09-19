import { Storage } from "@openomni/ledger";
import { Retry } from "@openomni/llm";

/**
 * How the executor persists and serves one retry schedule. `arm` commits the
 * durable `retry.scheduled` fact BEFORE any wait begins (record-before-act);
 * tests inject `wait` to resolve on state, never on timing.
 */
export interface RetryAlarmPort {
  /** Commit the retry.scheduled alarm; a refusal fails the attempt closed. */
  arm(input: {
    readonly id: string;
    readonly attempt: number;
    readonly reason: string;
    readonly fireAt: number;
  }): void | Promise<void>;
  /** Hold until the committed schedule elapses. */
  wait(fireAt: number, signal?: AbortSignal): Promise<void>;
  /** Consume the schedule (fenced cancel CAS); losing the race to the boot alarm owner is fine. */
  settle(id: string): void | Promise<void>;
}

/** Production port over the single alarm owner: alarm row + `alarm.arm` action in one transaction. */
export function createRetryAlarmPort(sessionId: string, clock: () => number): RetryAlarmPort {
  const alarms = () => {
    const adapter = Storage.get().alarms;
    if (adapter === undefined) throw new Error("L0 storage capability is unavailable: alarms");
    return adapter;
  };
  return {
    arm: (input) => {
      const row = alarms().arm({
        id: input.id,
        sessionId,
        kind: "at",
        fireAt: input.fireAt,
        spec: {
          encodingVersion: 1,
          value: {
            kind: "retry.scheduled",
            attempt: input.attempt,
            reason: input.reason,
            notBefore: input.fireAt,
          },
        },
      });
      if (row === undefined) throw new Error(`alarm arm refused: ${input.id}`);
    },
    wait: (fireAt, signal) => Retry.sleep(Math.max(0, fireAt - clock()), signal),
    settle: (id) => {
      alarms().cancel(id, sessionId, clock());
    },
  };
}
