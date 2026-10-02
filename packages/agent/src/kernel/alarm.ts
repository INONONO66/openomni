import type { Effect } from "effect";
import type { LedgerAction, SessionTransition } from "@openomni/protocol";
import type { CommitFailed } from "./failure";

/**
 * Alarm plane port types (#1247): pure contracts the kernel consumes. The
 * implementations (chain guards, DeliverAt senders, the ledger-backed retry
 * alarm) live in `session/alarm.ts`; the kernel takes these ports without
 * defaults.
 */
export type AlarmSkipReason =
  | "malformed_alarm_id"
  | "unknown_attempt"
  | "attempt_settled"
  | "superseded"
  | "unknown_request"
  | "request_terminal"
  | "duplicate_occurrence"
  | "duplicate_timeout";

export type AlarmDisposition =
  | { readonly op: "run" }
  | { readonly op: "skip"; readonly reason: AlarmSkipReason };

/** Chain reads a delivery guard decides over; the entity supplies its kernel's read ports. */
export interface AlarmChainReads {
  actionById(id: string): LedgerAction.Node | undefined;
  resultFor(intentId: string): LedgerAction.Node | undefined;
  operationChildrenPage(parentId: string, cursor: number): readonly LedgerAction.Node[];
  requestById(requestId: string): SessionTransition.Request | undefined;
}

/** `RetryScheduled` DeliverAt payload; `alarmId` = `<attemptActionId>:retry:<n>`. */
export interface RetryRearm {
  readonly alarmId: string;
  readonly attempt: number;
  readonly notBefore: number;
}

/** `Deadline` DeliverAt payload; chain key = `<requestId>:deadline`. */
export interface DeadlineArm {
  readonly requestId: string;
  readonly deadlineAt: number;
}

/** `WatchTimeout` DeliverAt payload; chain key = `<watchId>:timeout:<epoch>`. */
export interface WatchTimeoutArm {
  readonly watchId: string;
  readonly epoch: number;
  readonly fireAt: number;
}

/** DeliverAt self-senders, implemented over the Session entity client by the cluster runtime. */
export interface AlarmSenders {
  retryScheduled(message: RetryRearm): Effect.Effect<void, CommitFailed>;
  deadline(message: DeadlineArm): Effect.Effect<void, CommitFailed>;
  watchTimeout(message: WatchTimeoutArm): Effect.Effect<void, CommitFailed>;
}

/**
 * Durable retry schedule port over the alarm plane. Structurally a drop-in for
 * `ExecutorOptions["retryAlarm"]`: `arm` commits the `retry.scheduled` chain
 * action (durable evidence) and then persists the DeliverAt rearm; `wait`
 * keeps the live in-process residual sleep; `settle` is a no-op because
 * supersede happens at delivery time via `retryDelivery`, never as a cancel.
 */
export interface RetryAlarmPort {
  arm(input: {
    readonly id: string;
    readonly attempt: number;
    readonly reason: string;
    readonly fireAt: number;
  }): Effect.Effect<void, CommitFailed>;
  wait(fireAt: number, signal?: AbortSignal): Effect.Effect<void>;
  settle(id: string): Effect.Effect<void, CommitFailed>;
}

export interface RetryAlarmDeps {
  /** Commits the `retry.scheduled` chain action under the activation's fence. */
  readonly commitScheduled: (input: {
    readonly id: string;
    readonly attempt: number;
    readonly reason: string;
    readonly notBefore: number;
  }) => Effect.Effect<void, CommitFailed>;
  readonly send: AlarmSenders["retryScheduled"];
  readonly clock: () => number;
}
