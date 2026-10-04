import type { Effect } from "effect";
import type { LedgerAction } from "@openomni/protocol";
import type { CommitFailed } from "./failure";
import type { AlarmFired } from "./alarm";

/**
 * Alarm plane port types (#1247/#1254): pure contracts the kernel consumes.
 * The implementations (chain guard, the ledger-backed retry alarm) live in
 * `core/alarm.ts`; the kernel takes these ports without defaults.
 */

/**
 * Durable retry schedule port over the alarm chain (#1254). Structurally a
 * drop-in for `ExecutorOptions["retryAlarm"]`: `arm` commits the `alarm{arm}`
 * chain row (durable evidence) and then forwards the DeliverAt occurrence;
 * `wait` keeps the live in-process residual sleep; `settle` retires the chain
 * with an `at: null` arm so a completed attempt leaves no open alarm.
 */
export interface RetryAlarmPort {
  arm(input: {
    /** The attempt intent action id; the chain id is `<id>:retry`. */
    readonly id: string;
    readonly attempt: number;
    readonly reason: string;
    readonly fireAt: number;
  }): Effect.Effect<void, CommitFailed>;
  wait(fireAt: number, signal?: AbortSignal): Effect.Effect<void>;
  settle(input: {
    readonly id: string;
    readonly attempt: number;
  }): Effect.Effect<void, CommitFailed>;
}

export interface RetryAlarmDeps {
  readonly sessionId: string;
  /** Commits one arm append under the activation's fence (the turn's ledger). */
  readonly commitArm: (action: LedgerAction.Append) => Effect.Effect<void, CommitFailed>;
  /** Forwards one armed occurrence to the composed DeliverAt door; default void. */
  readonly send: (occurrence: AlarmFired) => Effect.Effect<void, CommitFailed>;
  readonly clock: () => number;
}
