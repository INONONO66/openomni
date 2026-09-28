import { Effect } from "effect";
import type { LedgerAction, SessionTransition } from "@openomni/protocol";
import type { CommitFailed } from "../errors";

/**
 * Timer plane over cluster DeliverAt (W5.2 review F2, plan D5/D8): a persisted
 * timer message is never cancelled in storage. Supersede = commit the winning
 * chain action first; a later delivery consults the chain and no-ops. The
 * dispositions below are those chain guards; the entity handler acks a "skip"
 * without committing anything.
 */
export type TimerSkipReason =
  | "malformed_alarm_id"
  | "unknown_attempt"
  | "attempt_settled"
  | "superseded"
  | "unknown_request"
  | "request_terminal"
  | "duplicate_occurrence"
  | "duplicate_timeout";

export type TimerDisposition =
  | { readonly op: "run" }
  | { readonly op: "skip"; readonly reason: TimerSkipReason };

const RUN: TimerDisposition = { op: "run" };
const skip = (reason: TimerSkipReason): TimerDisposition => ({ op: "skip", reason });

/** Chain reads a delivery guard decides over; the entity supplies its kernel's read ports. */
export interface TimerChainReads {
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
export interface TimerSenders {
  retryScheduled(message: RetryRearm): Effect.Effect<void, CommitFailed>;
  deadline(message: DeadlineArm): Effect.Effect<void, CommitFailed>;
  watchTimeout(message: WatchTimeoutArm): Effect.Effect<void, CommitFailed>;
}

const RETRY_SEPARATOR = ":retry:";
const PAGE_LIMIT = 256;

function hasNewerAttempt(reads: TimerChainReads, attempt: LedgerAction.Node): boolean {
  if (attempt.parentId === null) return false;
  let cursor = 0;
  for (;;) {
    const page = reads.operationChildrenPage(attempt.parentId, cursor);
    if (page.some((child) => child.kind === "attempt" && child.ordinal > attempt.ordinal))
      return true;
    if (page.length < PAGE_LIMIT) return false;
    cursor = page.at(-1)?.ordinal ?? cursor;
  }
}

/**
 * A redelivered `RetryScheduled` re-runs the open model attempt only while the
 * armed attempt is still the live, unsettled one: a settled terminal or a newer
 * attempt intent means the in-process residual wait already won (plan D8).
 */
export function retryDelivery(reads: TimerChainReads, alarmId: string): TimerDisposition {
  const separator = alarmId.lastIndexOf(RETRY_SEPARATOR);
  if (separator <= 0) return skip("malformed_alarm_id");
  const attemptId = alarmId.slice(0, separator);
  const attempt = reads.actionById(attemptId);
  if (attempt === undefined) return skip("unknown_attempt");
  if (reads.resultFor(attemptId) !== undefined) return skip("attempt_settled");
  if (hasNewerAttempt(reads, attempt)) return skip("superseded");
  return RUN;
}

/**
 * A `Deadline` delivery expires only a still-open request; any terminal state
 * (resolved/refused/expired/cancelled) acks silently so the resolution tokens
 * `duplicate`/`late_unknown` of the request plane stay intact (check4 F7).
 */
export function deadlineDelivery(reads: TimerChainReads, requestId: string): TimerDisposition {
  const request = reads.requestById(requestId);
  if (request === undefined) return skip("unknown_request");
  if (request.state !== "open") return skip("request_terminal");
  return RUN;
}

/** A `WatchFired` delivery commits at most once per committed occurrence id. */
export function watchFiredDelivery(reads: TimerChainReads, occurrenceId: string): TimerDisposition {
  if (reads.actionById(occurrenceId) !== undefined) return skip("duplicate_occurrence");
  return RUN;
}

/** The chain key one watch-timeout delivery commits under. */
export function watchTimeoutKey(message: Pick<WatchTimeoutArm, "watchId" | "epoch">): string {
  return `${message.watchId}:timeout:${message.epoch}`;
}

/** A `WatchTimeout` delivery is idempotent per (watchId, epoch). */
export function watchTimeoutDelivery(
  reads: TimerChainReads,
  message: Pick<WatchTimeoutArm, "watchId" | "epoch">,
): TimerDisposition {
  if (reads.actionById(watchTimeoutKey(message)) !== undefined) return skip("duplicate_timeout");
  return RUN;
}

/**
 * Durable retry schedule port over the timer plane. Structurally a drop-in for
 * `ExecutorOptions["retryAlarm"]`: `arm` commits the `retry.scheduled` chain
 * action (durable evidence) and then persists the DeliverAt rearm; `wait`
 * keeps the live in-process residual sleep; `settle` is a no-op because
 * supersede happens at delivery time via `retryDelivery`, never as a cancel.
 */
export interface RetryTimerPort {
  arm(input: {
    readonly id: string;
    readonly attempt: number;
    readonly reason: string;
    readonly fireAt: number;
  }): Effect.Effect<void, CommitFailed>;
  wait(fireAt: number, signal?: AbortSignal): Effect.Effect<void>;
  settle(id: string): Effect.Effect<void, CommitFailed>;
}

export interface RetryTimerDeps {
  /** Commits the `retry.scheduled` chain action under the activation's fence. */
  readonly commitScheduled: (input: {
    readonly id: string;
    readonly attempt: number;
    readonly reason: string;
    readonly notBefore: number;
  }) => Effect.Effect<void, CommitFailed>;
  readonly send: TimerSenders["retryScheduled"];
  readonly clock: () => number;
}

export function createRetryTimerPort(deps: RetryTimerDeps): RetryTimerPort {
  return {
    // Chain evidence strictly before the persisted rearm: a crash between the
    // two resumes from the chain on activation; a crash inside the wait is
    // woken by the redelivered message, which no-ops when the live path won.
    arm: (input) =>
      deps
        .commitScheduled({
          id: input.id,
          attempt: input.attempt,
          reason: input.reason,
          notBefore: input.fireAt,
        })
        .pipe(
          Effect.flatMap(() =>
            deps.send({ alarmId: input.id, attempt: input.attempt, notBefore: input.fireAt }),
          ),
        ),
    wait: (fireAt, signal) =>
      Effect.suspend(() => {
        const sleep = Effect.sleep(Math.max(0, fireAt - deps.clock()));
        if (signal === undefined) return sleep;
        const aborted = Effect.callback<never>((resume) => {
          const abort = () => resume(Effect.interrupt);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          return Effect.sync(() => signal.removeEventListener("abort", abort));
        });
        return sleep.pipe(Effect.raceFirst(aborted));
      }),
    settle: () => Effect.void,
  };
}
