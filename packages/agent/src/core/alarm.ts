import { Effect } from "effect";
import { interruptOn } from "./ports";
import type { LedgerAction, } from "@openomni/protocol";
import type { AlarmSkipReason, AlarmDisposition, AlarmChainReads, WatchTimeoutArm, RetryAlarmPort, RetryAlarmDeps } from "./alarm-ports";

export type { AlarmDisposition, AlarmChainReads, WatchTimeoutArm, RetryAlarmPort, RetryAlarmDeps } from "./alarm-ports";

/**
 * Timer plane over cluster DeliverAt (W5.2 review F2, plan D5/D8): a persisted
 * timer message is never cancelled in storage. Supersede = commit the winning
 * chain action first; a later delivery consults the chain and no-ops. The
 * dispositions below are those chain guards; the entity handler acks a "skip"
 * without committing anything.
 */


const RUN: AlarmDisposition = { op: "run" };
const skip = (reason: AlarmSkipReason): AlarmDisposition => ({ op: "skip", reason });






const RETRY_SEPARATOR = ":retry:";
const PAGE_LIMIT = 256;

function hasNewerAttempt(reads: AlarmChainReads, attempt: LedgerAction.Node): boolean {
  if (attempt.parentId === null) return false;
  let cursor = 0;
  for (;;) {
    const page = reads.operationChildrenPage(attempt.parentId, cursor);
    if (page.some((child) => child.kind === "llm" && child.ordinal > attempt.ordinal))
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
export function retryDelivery(reads: AlarmChainReads, alarmId: string): AlarmDisposition {
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
export function deadlineDelivery(reads: AlarmChainReads, requestId: string): AlarmDisposition {
  const request = reads.requestById(requestId);
  if (request === undefined) return skip("unknown_request");
  if (request.state !== "open") return skip("request_terminal");
  return RUN;
}

/** A `WatchFired` delivery commits at most once per committed occurrence id. */
export function watchFiredDelivery(reads: AlarmChainReads, occurrenceId: string): AlarmDisposition {
  if (reads.actionById(occurrenceId) !== undefined) return skip("duplicate_occurrence");
  return RUN;
}

/** The chain key one watch-timeout delivery commits under. */
export function watchTimeoutKey(message: Pick<WatchTimeoutArm, "watchId" | "epoch">): string {
  return `${message.watchId}:timeout:${message.epoch}`;
}

/** A `WatchTimeout` delivery is idempotent per (watchId, epoch). */
export function watchTimeoutDelivery(
  reads: AlarmChainReads,
  message: Pick<WatchTimeoutArm, "watchId" | "epoch">,
): AlarmDisposition {
  if (reads.actionById(watchTimeoutKey(message)) !== undefined) return skip("duplicate_timeout");
  return RUN;
}



export function createRetryAlarmPort(deps: RetryAlarmDeps): RetryAlarmPort {
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
        return sleep.pipe(Effect.raceFirst(interruptOn(signal)));
      }),
    settle: () => Effect.void,
  };
}
