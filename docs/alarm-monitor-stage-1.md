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
  fence the source first; only pause sends a final prompt. A stale process exit
  cannot add a wake.
- Exactly one of persistent:true and positive timeout_ms is required. Timeout
  is an absolute watch-row deadline, not a session timer or another alarm row.
- Wake budget is an immutable compiled policy obligation, scoped to an alarm
  epoch. N matching notifications are followed by one budget-pause prompt on
  N+1; no automatic refill or resume. Explicit rearm starts a fresh budget.
- Path watches observe one exact absolute pathname through its parent directory,
  with create or modify events. Backend rename is classified by pathname
  existence. The same source reconciles stat identity during the app's due scan,
  so missing/coalesced native notifications cannot strand a still-present change.
  Unchanged scans append nothing; commit must succeed before the source advances
  its observed identity. Transient create/delete pairs entirely between observed
  snapshots are not replayed. Errors fail visibly rather than inventing changes.
- The app owns one evaluator band outside session residency. Boot discovers
  armed at alarms and persistent watches. Live streams restart from now: output
  in the restart gap is not replayed and delivery across that gap is at-most-once.
  A command is restart-idempotent only if its author makes it so. No automatic
  retry of a terminated command is implied by persistent.
- Polling scans and lease bookkeeping are operational observations only. A
  firing commits alarm.fired, prompt action and inbox row atomically; the bus
  and session doorbell follow the transaction. The action revision advances for
  each action, not each transaction.

## Operations

The normal app boot mounts the alarm band after session recovery and before
channel binding. Shutdown invalidates source fences before closing the PTY or
filesystem handle; it does not cancel durable armed rows. One-second due scans
recover missed bus observations and process-worker-created rows. Operators
inspect the existing alarm row and action/inbox history, not a second watcher
registry. Source and wake errors are reported by the app. A timed watch lost
across worker restart produces a restart summary rather than rerunning effects;
a persistent watch starts from now, preserving its epoch and dedupe digest.
Only explicitly idempotent polling commands should be relied on for repeated
external effects. The band assumes one active app per database; unified
multi-owner evaluator leasing is #971's separate target.

Owner-approved input amendment (2026-09-06): `monitor` has one object-root
`operation` field, following the existing approval/provision ABI. Inside it,
`op` discriminates create/rearm/cancel:

```json
{"operation":{"op":"create","description":"Watch readiness","source":{"kind":"command","command":"printf 'READY\\n'","filter":"^READY$","persistent":true}}}
{"operation":{"op":"create","description":"Watch file creation","source":{"kind":"path","path":"/tmp/ready","event":"create","timeout_ms":60000}}}
{"operation":{"op":"rearm","alarmId":"returned-alarm-id"}}
{"operation":{"op":"cancel","alarmId":"returned-alarm-id"}}
```

Exactly one source and lifetime is required on create. Both control operations
require the stable alarmId. Root and operation variants stay below the existing
five-field cap; no exemption or baseline growth is needed.

## Boundaries

The #969 request/answer CAS, destination receipt and outbound obligation
cutovers; #970 session recovery ownership; #971 unified occurrence transition
product/active-key authority and session/evaluator lease composition; #972
history projections; and #973 lifecycle harness remain exclusively theirs.
Stage 1 does not claim their receipt registrations or their target semantics.

Stage 2 after #946 owes the message-deadline consumer's migration to kind:at,
reply/deadline winner and restart acceptance through that consumer, and B4's
exact timer-owner deletion receipt. No other stage-1 functionality is deferred.
