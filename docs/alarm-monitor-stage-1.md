# Alarm/monitor stage-1 decision annex (#947)

Frozen before implementation, against `b1da490c` (2026-09-06).
This is the #930 working baseline, not a receipt for #969-#973's unified
transition campaign. The existing alarm table and createAlarms remain owners.
No delegation file or deadline consumer is changed in stage 1.

## Decisions

- A generated alarm id is the stable control identity and inbox origin. Explicit
  rearm keeps it, advances epoch, resets the notification count and consecutive
  batch digest. Cancel is terminal; a new create is required afterwards.
- Each evaluator acquisition advances a persisted fence. Control commits fence
  callbacks before source cleanup. Ordinary worker takeover preserves epoch,
  notification count and digest; it is not explicit rearm.
- Command output is UTF-8 framed by newline, independent of PTY read chunks.
  Each complete line is one batch; an unterminated final line is flushed at EOF.
  PTY CRLF is decoded as a line delimiter. Regex uses JavaScript syntax without
  flags. Matching line content is otherwise unchanged. Consecutive matching
  line batches are suppressed by their durable digest, including after restart.
- A match does not finish a watch. Natural process exit and timeout produce one
  JSON summary with alarm id, epoch, reason and exit code. Cancel and pause
  notifications are the control terminal; stale process exit cannot add a wake.
- Exactly one of persistent:true and positive timeout_ms is required. Timeout
  is an absolute watch-row deadline, not a session timer or another alarm row.
- Wake budget is an immutable compiled policy obligation, scoped to an alarm
  epoch. N matching notifications are followed by one budget-pause prompt on
  N+1; no automatic refill or resume. Explicit rearm starts a fresh budget.
- Path watches observe one exact absolute pathname through its parent directory,
  with create or modify events. Backend rename is classified by pathname
  existence. Events are observations, not replay cursors. Overflow/errors fail
  visibly rather than inventing changes.
- The app owns one evaluator band outside session residency. Boot discovers
  armed at alarms and persistent watches. Live streams restart from now: output
  in the restart gap is not replayed and delivery across that gap is at-most-once.
  A command is restart-idempotent only if its author makes it so. No automatic
  retry of a terminated command is implied by persistent.
- Polling scans and lease bookkeeping are operational observations only. A
  firing commits alarm.fired, prompt action and inbox row atomically; the bus
  and session doorbell follow the transaction. The action revision advances for
  each action, not each transaction.

## Boundaries

The #969 request/answer CAS, destination receipt and outbound obligation
cutovers; #970 session recovery ownership; #971 unified occurrence transition
product/active-key authority and session/evaluator lease composition; #972
history projections; and #973 lifecycle harness remain exclusively theirs.
Stage 1 does not claim their receipt registrations or their target semantics.

Stage 2 after #946 owes the message-deadline consumer's migration to kind:at,
reply/deadline winner and restart acceptance through that consumer, and B4's
exact timer-owner deletion receipt. No other stage-1 functionality is deferred.
