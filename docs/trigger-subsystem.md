# Unified Trigger subsystem

Status: **designed, not implemented**. This document is the normative design for the
next implementation slice. It is not evidence that any of the paths named here
are currently shipped. [Implementation Status](implementation-status.md) remains
the source of truth for deployed behavior.

## 0. Recommendation and decision summary

**Recommendation:** implement alarms and watch subscriptions as one vertical
Trigger slice across protocol, ledger, and the sole app. Do not revive the
retired CronJob API, add a scheduler package, or split the app into a daemon.

**Estimate:** **Large**, roughly 5-8 engineering days for the protocol and pure
folds, SQLite/memory parity, app sources and delivery, migration, and the full
failure matrix. The estimate includes tests and the boot exercise; it excludes
process resurrection and any new deployment supervisor.

The design makes these choices explicit:

1. A `Trigger` is durable intent owned by one Resident session. Its only source
   kinds are `time.once`, `time.every`, `event.command`, and `event.file`.
2. Trigger lifecycle and fire delivery lifecycle are separate. A trigger is
   `armed`, `paused`, or `ended(reason)`. Each fire is independently
   `recorded`, `delivered`, or `acked`.
3. For each observation, its Fire is durably recorded before any route or
   Resident delivery action. Source handles are started only after the Trigger
   row commits; they are source registration effects, not an unrecorded Fire
   action. A Fire is acknowledged only after the Resident session has durably
   admitted the message. Delivery is at-least-once; the admission key makes the
   session write idempotent.
4. Boot re-arms every `armed` trigger and re-pushes every unacked fire. A child
   process that existed before a host crash is not resurrected; an armed command
   source starts a new child from its recorded configuration.
5. The scheduler is a pure fold over injected clock, timer, and identifier
   facts. One deadline handle exists per trigger, one fire may be in flight, and
   missed recurring occurrences collapse to one catch-up fire.
6. The notifier is a pure bounded fold. It ports the senpi coalescing window,
   per-trigger rate limit, line-batch fingerprint suppression, wake budget,
   explicit re-arm, terminal bypass, and counted overflow semantics.
7. Command and file sources are app-only effects. Command output is newline
   framed and regex filtered; process exit always produces a summary. File
   watching pins the real parent and re-checks symlink and device/inode identity
   before accepting a change.
8. The four model-facing tools are Resident-only and are registered through the
   existing `CATALOG_TOOLS` seam. The create schema is a flat top-level object
   with a nested source object, not a root union, so provider schema conversion
   and the five-field tool lint remain valid.

The senpi files named in the seed were read as a semantic reference. Their
classes, sidecar files, PTY objects, and TypeScript shapes are not copied.
OpenOmni keeps its Zod-first contracts, ledger transactions, and app composition
rules.

## 1. Scope, ownership, and topology

### 1.1 Layer contract

```text
packages/protocol
  Trigger schemas, event descriptors, scheduler fold, notifier fold
        <-
packages/ledger
  TriggerStore, TriggerFireStore, raw adapters, facts, SQLite migration
        <-
apps/openomni
  Trigger host, clock/timers, command/file sources, notifier effects,
  internal delivery, boot/shutdown wiring, Resident tools
```

The dependency and ownership rules are:

| Layer | Owns | Must not own |
| --- | --- | --- |
| `packages/protocol` | Zod schemas, pure transitions, pure bounded notification decisions, stream/fact vocabulary | clocks, timers, child processes, `fs`, storage, Resident/session access, routing judgment |
| `packages/ledger` | typed trigger and fire stores, append/projection transactions, SQLite and test-memory adapters | delivery, source handles, routing, tool authorization, prompt execution |
| `apps/openomni` | composition, source effects, scheduler host, notifier host, internal delivery, Resident tools and boot recovery | a second schema/fold, direct SQLite access, bypassing the store or Gateway contract |
| `packages/channels` | external direct-mode perimeter routing | accepting internal trigger input, reading trigger rows, reading session content |
| Resident | session admission and normal turn execution | deciding whether a fire was durably recorded or acknowledging before admission |

There is one database. No `packages/trigger`, `packages/scheduler`, or second
storage engine is introduced. No new protocol noun named `Runtime`, `Task`, or
`Envelope` is introduced.

### 1.2 Meaning of the three durable objects

- **Trigger:** an immutable source configuration plus mutable lifecycle and
  scheduling projection. There is no edit tool. Replacing a prompt or source
  means ending the old trigger and creating a new one.
- **Fire:** one immutable snapshot of what the trigger promised to deliver at a
  particular observation. Its status is the durable delivery receipt.
- **Observation:** bounded source data waiting to be included in a fire. It is
  not a fourth durable lifecycle object. While a fire is in flight, the
  trigger's bounded `pendingBatch` projection preserves the one coalesced
  follow-up across a crash.

Trigger and fire rows are brain-side product state stored by ledger. The
`ownerSessionId` is an opaque bridge identifier; the trigger store does not
create, delete, or inspect session content and has no foreign key to `session`.
A missing owner session is a delivery failure, not permission to silently route
to a new session.

### 1.3 Existing topology reconciliation

The current gateway design says that internal mode never crosses the external
perimeter. This design preserves that rule. In this document, "gateway ingest"
means the **internal arm of the app's injected `Gateway.Deliver` seam**, not
`packages/channels`' public external `GatewayRouter.ingest` method:

- `GatewayRouter.ingest` remains direct-only and continues to reject internal
  events from channel drivers. Its injected delivery callback is narrowed to
  `Gateway.ExternalDeliver`, so the package cannot accidentally become an
  internal-trigger entry point.
- The app adds an explicit internal-delivery facade in
  `apps/openomni/src/trigger/delivery.ts`. It builds an internal-mode
  `Ingress.InternalEvent` inside `Gateway.InternalDeliver`, records the
  internal `route.decided` fact, and invokes the same injected Resident
  delivery consumer. A trigger never calls the Resident function around the
  gateway seam.
- The protocol keeps the current external shape as
  `Gateway.ExternalDeliver`, adds a strict `Gateway.InternalDeliver`, and
  defines `Gateway.Deliver = z.union([Gateway.ExternalDeliver,
  Gateway.InternalDeliver])`. `Gateway.DeliveredEvent` remains the external
  event residue used by the channels router. The external router parses only
  `Gateway.ExternalDeliver`; the app trigger facade constructs only
  `Gateway.InternalDeliver`. There is one typed union, not two ad-hoc
  callbacks.

  The internal variant is exactly:

  ```ts
  Gateway.InternalDeliver = z.object({
    sessionId: z.string().min(1),
    event: Ingress.InternalEventSchema,
    decision: Ingress.Events.RoutingDecision.schema,
  }).strict().superRefine((delivery, ctx) => {
    // event.mode = "internal", event.surface = "internal",
    // event.agentName = "resident", event.payload is text,
    // event.target = { kind: "resident", sessionId },
    // decision.mode = "internal", stage = "surface_default",
    // outcome = "route", inboundId = event.id, sessionId matches,
    // target = `resident:${sessionId}`, surface and traceId match event.
  });
  ```

  The schema also requires the internal event's `meta.kind` to be
  `trigger.fire` and its `meta.triggerId`/`meta.fireId` to be non-empty. It has
  no `actorContext` and no `waitContext`; those fields are not silently
  defaulted from an external actor. `decision.time` is the delivery fact time
  chosen by the host (the Fire's immutable `recordedAt`), not a second timestamp
  hidden in the event; replay equivalence deliberately ignores that
  delivery-local time just as it does for external routes.
- The internal route has no channel grant, blacklist, Wait correlation, or
  external actor resolution. Its target is the owner session carried from the
  durable trigger row, and its route decision is still recorded before the
  Resident acts.

This is an internal delivery path, not a new network boundary and not a second
routing engine. The existing `Ingress.InternalEventSchema` and the
`activation.trigger.kind` values (`cron` and `internal`) are reused.

### 1.4 Measured repository topology

Measured on 2026-09-01 at commit `637dd47d` on `feat/trigger-subsystem`:
`apps/openomni/src/trigger/`, `packages/protocol/src/trigger/`,
`packages/ledger/src/trigger/`, and migration `0030_trigger_subsystem` do not
exist yet. The current external entry is
`packages/channels/src/router/index.ts`; the app composition entry is
`apps/openomni/src/index.ts`; and the current migration tail is
`0029_provisioning`. Existing `packages/channels/src/authn/triggers.ts` and
`packages/channels/src/support/trigger.ts` are unrelated channel helper
surfaces, not Trigger records, and must not be repurposed. The historical
`packages/ledger/migration/0004_cron_job/` directory remains present by design;
no proposed file restores its deleted Cron store/runner API.

## 2. Protocol contract

All schemas below are sketches of the exact public shape. The implementation
uses the repository's namespace-plus-Zod convention (`Trigger.Record` is both
the schema and its inferred type), `.strict()` objects, `EpochMs`, and
`NamedError`. `Trigger.canonicalDigest` re-exports the existing protocol JSON
digest owner; neither the app nor ledger defines another serializer/hash
profile. IDs are generated by the app and are never model input.

### 2.1 Constants and vocabularies

```ts
Trigger.Kinds = [
  "time.once",
  "time.every",
  "event.command",
  "event.file",
] as const;

Trigger.LifecycleStates = ["armed", "paused", "ended"] as const;
Trigger.FireStatuses = ["recorded", "delivered", "acked"] as const;
Trigger.SourceEventKinds = ["line", "summary"] as const;

Trigger.KindName = (typeof Trigger.Kinds)[number];
Trigger.LifecycleState = (typeof Trigger.LifecycleStates)[number];
Trigger.FireStatus = (typeof Trigger.FireStatuses)[number];
```

The normative limits are fixed in protocol code; they are not model- or
environment-tunable in this slice:

```ts
Trigger.Constants = {
  ACTIVE_TRIGGER_CAP: 5,
  TRANSITION_BATCH_CAP: 6,             // one emission + five active triggers
  MIN_RECURRING_INTERVAL_MS: 60_000,
  RECURRING_LIFETIME_MS: 604_800_000, // 7 days
  SOURCE_TIMEOUT_MS: 300_000,          // 5 minutes; ignored when persistent
  SOURCE_KILL_GRACE_MS: 1_000,
  DELIVERY_RETRY_BASE_MS: 1_000,
  DELIVERY_RETRY_MAX_MS: 60_000,
  MAX_COMMAND_CHARS: 8_192,
  MAX_FILTER_CHARS: 1_024,
  MAX_PATH_CHARS: 4_096,

  NOTIFIER_COALESCE_WINDOW_MS: 2_000,
  NOTIFIER_RATE_LIMIT_MS: 5_000,
  NOTIFIER_MAX_LINES: 50,
  NOTIFIER_MAX_CHARS: 4_096,            // framing included
  NOTIFIER_WAKE_BUDGET: 5,
  QUEUE_OVERHEAD_CHARS: 512,
  WAKE_STREAK_QUIET_GAP_MULTIPLIER: 2,

  MAX_PROMPT_CHARS: 16_384,
  MAX_EVENT_TEXT_CHARS: 1_024,
  MAX_DETAIL_CHARS: 1_024,
  // Full prompt + one bounded notifier block + fixed trigger framing. The
  // notifier's own 4,096-character ceiling remains unchanged.
  FIRE_ENVELOPE_CHARS: 512,
  MAX_FIRE_PAYLOAD_CHARS: 20_992,
  MAX_PARTIAL_LINE_CHARS: 1_024,
  MAX_TRIGGER_LIST_ROWS: 100,
  MAX_COUNTER: 9_007_199_254_740_991, // Number.MAX_SAFE_INTEGER

  SET_TIMEOUT_MAX_MS: 2_147_483_647,
  FILE_DIGEST_SAMPLE_BYTES: 65_536,
  FILE_SAFETY_POLL_MS: 250,
  FILE_DIRTY_RECHECK_LIMIT: 1,
} as const;
```

The five-trigger cap and seven-day recurring lifetime follow the senpi scheduler's
`MAX_ACTIVE_LOOPS` and `LOOP_EXPIRY_MS` safety priors. Six is the exact maximum
atomic notifier batch: one emission transition plus pauses for all five active
triggers. The 60-second minimum prevents a model-created recurrence from
becoming a tight wake loop. The notifier values preserve senpi's proven 2,000
ms / 5,000 ms / 50-line / 4,096-character / five-wake defaults. Its 512-character
queue reserve pays for labels, separators, overflow disclosure, and the fifth-wake
notice before item text is accepted; the quiet-gap multiplier resets a wake
streak only after two complete rate-limit windows (10 seconds). A five-minute
finite-source timeout is the senpi monitor default; `persistent: true` is the
explicit opt-out. The signed 32-bit timer ceiling is the Node `setTimeout`
maximum, so the app must chain segments rather than rely on a platform-specific
clamp.

`NOTIFIER_MAX_CHARS` bounds only the rendered observation block, exactly as in
the monitor precedent. A Fire also carries the complete immutable prompt. Its
20,992-character bound is therefore `MAX_PROMPT_CHARS + NOTIFIER_MAX_CHARS +
FIRE_ENVELOPE_CHARS`; a valid prompt is never silently clipped to make room for
an observation. The renderer charges item labels and separators to the
notifier block and refuses an over-budget reservation as `corrupt` rather than
performing an undocumented final truncation.

All interval, count, attempt, and tool integer fields use one
`PositiveSafeInt`/`NonNegativeSafeInt` helper capped at `MAX_COUNTER`; the
shorter `z.number().int()` calls below are sketches of that shared constraint.
Canonical identities use the existing protocol JSON owner and one exact digest
shape:

```ts
Trigger.CanonicalDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
// Trigger.canonicalDigest re-exports the existing implementation in json.ts.
```

The stored source union is:

```ts
Trigger.Source = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("time.once"),
    at: EpochMs,
  }).strict(),

  z.object({
    kind: z.literal("time.every"),
    // This is the effective interval after the minimum clamp. The requested
    // value is retained on Trigger.Record for audit/display.
    intervalMs: z.number().int().positive().max(MAX_COUNTER),
  }).strict(),

  z.object({
    kind: z.literal("event.command"),
    command: z.string().min(1).max(MAX_COMMAND_CHARS),
    filter: z.string().max(MAX_FILTER_CHARS).optional(),
    persistent: z.boolean(),
  }).strict(),

  z.object({
    kind: z.literal("event.file"),
    path: z.string().min(1).max(MAX_PATH_CHARS),
    on: z.enum(["create", "modify"]),
  }).strict(),
]);
```

`event.command.persistent` defaults to `false` only on the model-facing create
input. It is always present in a stored record. The union's outer refinement
constructs `new RegExp(filter)` when a filter is present and reports a Zod issue
on failure, so stored records as well as tool input reject invalid ECMAScript
expressions. A `time.every` create input retains `requestedIntervalMs`;
`Source.intervalMs` is the effective value.

### 2.2 Lifecycle and trigger record

```ts
Trigger.PauseReason = z.enum([
  "wake_budget",
  "source_unavailable",
  "owner_session_missing",
  "recovery_conflict",
]);

Trigger.EndReason = z.enum([
  "cancelled",
  "completed",
  "expired",
  "source_exited",
  "source_timeout",
  "source_error",
]);

Trigger.TerminalFireReason = z.enum([
  "cancelled",
  "completed",
  "source_exited",
  "source_timeout",
  "source_error",
]);

Trigger.Lifecycle = z.discriminatedUnion("state", [
  z.object({ state: z.literal("armed") }).strict(),
  z.object({
    state: z.literal("paused"),
    pauseReason: Trigger.PauseReason,
    pausedAt: EpochMs,
  }).strict(),
  z.object({
    state: z.literal("ended"),
    endReason: Trigger.EndReason,
    endedAt: EpochMs,
    endDetail: z.string().max(MAX_DETAIL_CHARS).optional(),
  }).strict(),
]);

Trigger.Record = z.object({
  id: z.string().min(1),
  ownerSessionId: z.string().min(1),
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
  source: Trigger.Source,
  lifecycle: Trigger.Lifecycle,

  createdAt: EpochMs,
  updatedAt: EpochMs,
  revision: z.number().int().positive().max(MAX_COUNTER),

  // Only time.every and finite event sources have an expiry. A once alarm has
  // no expiry: a late once alarm must still fire exactly once.
  expiresAt: EpochMs.optional(),
  requestedIntervalMs: z.number().int().positive().max(MAX_COUNTER).optional(),
  effectiveIntervalMs: z.number().int().positive().max(MAX_COUNTER).optional(),
  nextFireAt: EpochMs.optional(),
  // Required and initialized to createdAt, so a restart after a wall-clock
  // rollback cannot forget the last accepted logical instant.
  lastObservedAt: EpochMs,
  lastFiredAt: EpochMs.optional(),
  fireCount: z.number().int().min(0).max(MAX_COUNTER),

  // Durable scheduler gate. An ended trigger may retain this field while its
  // final fire is being delivered.
  inFlightFireId: z.string().min(1).optional(),
  coalescedFirePending: z.boolean(),
  pendingBatch: Trigger.PendingBatch.optional(),
}).strict();
```

`MAX_PROMPT_CHARS` is 16,384. The record refinement is the one enforcement
layer for these invariants:

- `time.once` has no `nextFireAt`, interval fields, or `expiresAt`.
- `time.every` has effective and requested interval fields, a `nextFireAt`, and
  `expiresAt = createdAt + RECURRING_LIFETIME_MS`; its first
  `nextFireAt = createdAt + effectiveIntervalMs`, and creation rejects
  `nextFireAt >= expiresAt`. `source.intervalMs === effectiveIntervalMs`; the
  indexed/display projection may never drift from the stored source.
- `event.command` has no `nextFireAt`; `persistent: false` has
  `expiresAt = createdAt + SOURCE_TIMEOUT_MS`, while `persistent: true` has no
  deadline. The process exit remains its terminal condition. A command's
  normalized string is at most `MAX_COMMAND_CHARS` and its regex at most
  `MAX_FILTER_CHARS`.
- `event.file` has no `nextFireAt` and has `expiresAt = createdAt +
  SOURCE_TIMEOUT_MS`.
- A finite-source expiry is absolute from `createdAt`, including time spent
  paused or unavailable. A restore/rearm at or after that deadline
  reserve/coalesces one timeout summary and ends the source with
  `source_timeout` without opening a handle, rather than extending its
  lifetime.
- `effectiveIntervalMs >= MIN_RECURRING_INTERVAL_MS`, and an effective interval
  that cannot produce a fire before expiry is rejected at creation. Every
  derived deadline uses checked safe-integer arithmetic: creation rejects an
  expiry or first deadline above `MAX_COUNTER`, and recurrence compares
  `effectiveIntervalMs` with `expiresAt - logicalNow` before adding. A next
  occurrence that reaches or exceeds expiry is represented by the safe
  `expiresAt` value and the trigger ends; JavaScript overflow is never used as
  a scheduling decision.
- `coalescedFirePending` is false exactly when `pendingBatch` is absent. A
  pending batch is legal only while `inFlightFireId` is present. Its `items`
  may be empty only for an explicit recurring schedule marker or an
  overflow-only source batch. The marker has no terminal reason and zero
  overflow; an overflow-only source batch has positive overflow and is never a
  schedule marker. Both drain to one Fire. The batch is bounded by 50 items and
  by 3,584 rendered characters (`4,096 - 512` framing overhead), including
  item labels and separators;
  `overflowCount`, `fireCount`, and `deliveryAttempts` are integers in
  `0..MAX_COUNTER`. Overflow and count increments saturate at `MAX_COUNTER`
  rather than wrapping. It is a durable summary, not an unbounded output
  buffer.
- `revision` is the head of `trigger:<id>` and begins at one. Every lifecycle,
  reservation, coalescing, and release mutation advances it once, including
  each sequential fact in a release-plus-pending-reservation transaction. A
  row already at `MAX_COUNTER` is `corrupt` and refuses mutation; revisions
  never saturate because that would break head equality.
- `lastObservedAt` starts at `createdAt` and is advanced durably on every
  accepted scheduler/source observation, lifecycle command, and restore. The
  scheduler's logical clock is therefore monotonic across a process restart as
  well as within one process.
- A stored `payloadDigest` is `canonicalDigest(payload)` and a pending
  `fingerprint` is the canonical digest of its bounded items, timestamps,
  overflow count, schedule-marker bit/instant, and terminal reason; a mismatch
  is a corrupt record, never a reason to recompute silently. `terminalReason` is present only when the
  batch contains a `summary`; an empty recurring marker has no terminal reason.
- Terminal fields never appear on non-terminal lifecycle variants. An `ended`
  trigger accepts no new observation, but may finish its current Fire and
  reserve exactly one batch already accepted before ending: either the terminal
  source summary or a recurring schedule marker observed strictly before
  expiry. No other non-terminal pending batch is legal.

`Trigger.PendingBatch` is deliberately small:

```ts
Trigger.PendingBatch = z.object({
  items: z.array(z.object({
    kind: z.enum(["line", "summary"]),
    text: z.string().min(1).max(MAX_EVENT_TEXT_CHARS),
    at: EpochMs,
  }).strict()).max(NOTIFIER_MAX_LINES),
  overflowCount: z.number().int().min(0).max(MAX_COUNTER),
  scheduleMarker: z.boolean(),
  // Required exactly for a recurring marker; replaced by the latest legal
  // due instant when several occurrences collapse.
  scheduledForAt: EpochMs.optional(),
  firstAt: EpochMs,
  lastAt: EpochMs,
  terminalReason: Trigger.TerminalFireReason.optional(),
  // canonicalDigest({ items, overflowCount, scheduleMarker, scheduledForAt,
  //   firstAt, lastAt, terminalReason }) after every merge; permits an interrupted coalesce
  // retry to be idempotent.
  fingerprint: Trigger.CanonicalDigest,
}).strict();
```

A pending batch can contain at most one terminal summary for a source. Items
remain in stable arrival order, every item timestamp lies in the inclusive
`firstAt..lastAt` range, and `firstAt <= lastAt`. A terminal batch carries the
corresponding `terminalReason`. A schedule marker has `scheduleMarker: true`,
empty items, zero overflow, no terminal reason, and a required
`scheduledForAt`; a source batch has no scheduled instant. On first coalesce,
`firstAt = lastAt = logicalNow` and `scheduledForAt` is the due value consumed.
Further legal due observations advance `lastAt` and replace `scheduledForAt`
with the latest due value, so all missed periods still drain as one coalesced
alarm Fire (`firedAt = lastAt`). A source batch has `scheduleMarker: false`; it may be empty only when its overflow is positive,
and that overflow-only batch produces a bounded Fire containing the disclosed
count. The schema refinement also requires the rendered item total — item-kind labels,
separators, overflow disclosure, and text, not text alone — to fit the
`NOTIFIER_MAX_CHARS - QUEUE_OVERHEAD_CHARS` rendered budget. Its fingerprint is
recomputed with `canonicalDigest` after each merge. If a retry presents the
same fingerprint, the store returns an idempotent coalesce receipt without
appending another fact. If a terminal summary is coalesced behind an existing
fire, it is retained and non-terminal pending lines are discarded once the
summary is reserved.

### 2.3 Create input

The internal create contract includes the app-minted ID, owner, and injected
timestamp; the tool surface does not expose any of those fields:

```ts
Trigger.Create = z.object({
  id: z.string().min(1),
  ownerSessionId: z.string().min(1),
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
  source: Trigger.CreateSource,
  at: EpochMs,
}).strict();
```

```ts
Trigger.CreateSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time.once"), at: EpochMs }).strict(),
  z.object({
    kind: z.literal("time.every"),
    intervalMs: z.number().int().positive().max(MAX_COUNTER),
  }).strict(),
  z.object({
    kind: z.literal("event.command"),
    command: z.string().min(1).max(MAX_COMMAND_CHARS),
    filter: z.string().max(MAX_FILTER_CHARS).optional(),
    persistent: z.boolean().default(false),
  }).strict(),
  z.object({
    kind: z.literal("event.file"),
    path: z.string().min(1).max(MAX_PATH_CHARS),
    on: z.enum(["create", "modify"]).default("create"),
  }).strict(),
]);
```

`Trigger.CreateSource` retains the four discriminants exactly. Its
`time.every` interval is the requested value; the tool adapter defaults command
`persistent` to `false` and file `on` to `"create"` before parsing the stored
form. The app reads the clock once and applies exactly one `trim()` to both the
prompt and command at the tool boundary, rejecting either empty result and any
command containing NUL; it then preserves each normalized string byte-for-byte
(there is no further shell-language normalization). It resolves a file path to an
absolute lexical path, validates a command regex before writing, and passes a
fully normalized create input to ledger. The configured app working directory
used for commands is a composition input, not model input.

`event.file` is a finite, one-match source in this slice, not a perpetual file
subscription: the first accepted create/modify transition emits its match and
terminal summary, then ends `completed`; the Owner creates another Trigger for a
later independent transition. Initial `on: "modify"` registration requires an
existing safe file and establishes its baseline without synthesizing a
historical change. Initial `on: "create"` registration requires absence; safe
presence discovered later during activation, recovery, or rearm is the requested
create event. A command source may remain alive for its configured lifetime, but
every command source also has exactly one terminal summary.

### 2.4 Fire record

A fire snapshots its rendered payload. Retrying a fire never re-reads a mutable
prompt, source output, current clock, or current configuration.

```ts
Trigger.FireCause = z.enum([
  "alarm",
  "source_line",
  "source_summary",
  "recovery",
  "coalesced",
]);

Trigger.FireAdmission = z.object({
  fireId: z.string().min(1),
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  payloadDigest: Trigger.CanonicalDigest,
  admittedAt: EpochMs,
}).strict();

Trigger.Fire = z.object({
  id: z.string().min(1),
  triggerId: z.string().min(1),
  ownerSessionId: z.string().min(1),
  traceId: z.string().min(1),
  payload: z.string().min(1).max(MAX_FIRE_PAYLOAD_CHARS),
  payloadDigest: Trigger.CanonicalDigest,
  cause: Trigger.FireCause,
  terminalReason: Trigger.TerminalFireReason.optional(),
  sourceItems: z.array(Trigger.SourceItem).max(NOTIFIER_MAX_LINES),
  overflowCount: z.number().int().min(0).max(MAX_COUNTER),
  scheduledForAt: EpochMs.optional(),
  firedAt: EpochMs,
  recordedAt: EpochMs,

  status: z.enum(["recorded", "delivered", "acked"]),
  deliveryAttempts: z.number().int().min(0).max(MAX_COUNTER),
  deliveredAt: EpochMs.optional(),
  ackedAt: EpochMs.optional(),
  admission: Trigger.FireAdmission.optional(),

  revision: z.number().int().positive().max(MAX_COUNTER),
  updatedAt: EpochMs,
}).strict();
```

```ts
Trigger.FireReservation = z.object({
  id: z.string().min(1),
  traceId: z.string().min(1),
  payload: z.string().min(1).max(MAX_FIRE_PAYLOAD_CHARS),
  payloadDigest: Trigger.CanonicalDigest,
  cause: Trigger.FireCause,
  terminalReason: Trigger.TerminalFireReason.optional(),
  sourceItems: z.array(Trigger.SourceItem).max(NOTIFIER_MAX_LINES),
  overflowCount: z.number().int().min(0).max(MAX_COUNTER),
  scheduledForAt: EpochMs.optional(),
  firedAt: EpochMs,
}).strict();
```

The fire refinement requires `deliveredAt` for `delivered` and `acked`, and
requires `ackedAt` plus `admission` for `acked`. It also requires
`admission.fireId === id` and `admission.payloadDigest === payloadDigest`.
For every Fire, `scheduledForAt <= firedAt <= recordedAt` when a schedule is
present, and `firedAt <= recordedAt` otherwise. Status timing then requires
`recordedAt <= deliveredAt <= admission.admittedAt <= ackedAt` with the
supplied facts (when the fields exist). For attempt/delivery/ack writes,
the host supplies `max(clock.now(), fire.updatedAt, trigger.lastObservedAt)`;
Resident admission additionally clamps to `deliveredAt`, and acknowledgement
also clamps to `admission.admittedAt`. A wall-clock rollback therefore cannot
make a valid Fire unparseable. `terminalReason` requires a
summary item except for a `time.once` alarm ending `completed` (an empty
recurring marker can never end a source). `scheduledForAt` is present exactly
for a time-source Fire, including a recovery alarm and a drained recurring
marker; internal command/file Fires omit it. `alarm` and `recovery` therefore
carry no source items, `source_line` carries only lines, `source_summary`
contains a summary, and `coalesced` is either an empty scheduled marker or a
non-empty source batch. The parent lifecycle transition in the reservation
transaction must use the same terminal reason. The store additionally requires
`fire.triggerId` to name an existing Trigger and
`fire.ownerSessionId` to equal that Trigger's owner; a row mismatch is
`corrupt`. A Fire ID is the stable delivery idempotency key. Fire rows are
retained for audit and replay inspection for the lifetime of the ledger; this
slice has no automatic Fire garbage collector. Cancel never deletes an unacked
Fire.

`Trigger.SourceItem` is the sanitized, bounded representation of a line or
summary:

```ts
Trigger.SourceItem = z.object({
  kind: z.enum(["line", "summary"]),
  text: z.string().min(1).max(MAX_EVENT_TEXT_CHARS),
  at: EpochMs,
}).strict();
```

The source driver, not the fold, first applies Node's
`stripVTControlCharacters`, removes remaining C0/DEL controls except tab with
`/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g`, then clips with
`.slice(0, MAX_EVENT_TEXT_CHARS)`; an empty result is ignored. The notifier then
applies the line/character limits. Source text is quoted data and is never
parsed as a command.

### 2.5 Events and facts

Bus descriptors are projections and publish only after the corresponding
ledger transaction. The descriptors contain IDs, state, timestamps, and
reasons; they do not duplicate a full shell command or raw output. Their exact
schema sketch is:

```ts
const TriggerEventBase = z.object({
  traceId: z.string().min(1),
  time: EpochMs,
  triggerId: z.string().min(1),
}).strict();

const TriggerRevision = z.object({
  triggerRevision: z.number().int().positive().max(MAX_COUNTER),
}).strict();

const FireEventBase = TriggerEventBase.extend({
  fireId: z.string().min(1),
  fireRevision: z.number().int().positive().max(MAX_COUNTER),
}).strict();

Trigger.Events = {
  Created: BusEvent.define("trigger.created", TriggerEventBase.extend({
    ownerSessionId: z.string().min(1),
    kind: z.enum(Trigger.Kinds),
    triggerRevision: TriggerRevision.shape.triggerRevision,
  }).strict(), { visibility: "user_audit" }),
  Paused: BusEvent.define("trigger.paused", TriggerEventBase.extend({
    pauseReason: Trigger.PauseReason,
    triggerRevision: TriggerRevision.shape.triggerRevision,
  }).strict(), { visibility: "user_audit" }),
  Rearmed: BusEvent.define("trigger.rearmed", TriggerEventBase.extend({
    triggerRevision: TriggerRevision.shape.triggerRevision,
    nextFireAt: EpochMs.optional(),
  }).strict(), { visibility: "user_audit" }),
  Ended: BusEvent.define("trigger.ended", TriggerEventBase.extend({
    endReason: Trigger.EndReason,
    triggerRevision: TriggerRevision.shape.triggerRevision,
  }).strict(), { visibility: "user_audit" }),
  FireRecorded: BusEvent.define("trigger.fire.recorded", FireEventBase.extend({
    cause: Trigger.FireCause,
    triggerRevision: TriggerRevision.shape.triggerRevision,
  }).strict(), { visibility: "internal" }),
  FireDelivered: BusEvent.define("trigger.fire.delivered", FireEventBase.extend({
    sessionId: z.string().min(1),
  }).strict(), { visibility: "internal" }),
  FireAcked: BusEvent.define("trigger.fire.acked", FireEventBase.extend({
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
  }).strict(), { visibility: "internal" }),
} as const;
```

`triggerRevision` always names the `trigger:<id>` head and `fireRevision`
always names the `trigger_fire:<id>` head; the generic name `revision` is not
used across the parent/child event boundary.

Delivery/source faults use the existing `Operational.Events.Error` descriptor;
a new error event is not added. Notification overflow is represented in the
fire row and payload, not a second event stream.

The decision facts are paired as follows:

| Stream | Fact | Projection written in the same transaction |
| --- | --- | --- |
| `trigger:<triggerId>` | `trigger.created` | insert the revision-one Trigger |
| `trigger:<triggerId>` | `trigger.restored` | advance the logical-clock watermark during boot recovery |
| `trigger:<triggerId>` | `trigger.paused`, `trigger.rearmed`, `trigger.ended` | lifecycle CAS |
| `trigger:<triggerId>` | `trigger.fire.reserved` | set `inFlightFireId`, advance schedule, increment `fireCount` |
| `trigger:<triggerId>` | `trigger.fire.coalesced` | set/merge bounded `pendingBatch` |
| `trigger:<triggerId>` | `trigger.fire.released` | clear the acknowledged in-flight ID |
| `trigger_fire:<fireId>` | `trigger.fire.recorded` | insert the revision-one Fire |
| `trigger_fire:<fireId>` | `trigger.fire.delivery_attempted` | increment attempt count |
| `trigger_fire:<fireId>` | `trigger.fire.delivered` | set `deliveredAt` and status |
| `trigger_fire:<fireId>` | `trigger.fire.acked` | set admission, `ackedAt`, and status |

A reservation appends `trigger.fire.reserved` and
`trigger.fire.recorded`, inserts the Fire, and updates the parent in one
transaction. A coalesce appends only the parent fact. An acknowledgement
appends `trigger.fire.acked` and `trigger.fire.released`; if a pending batch
exists, its next `trigger.fire.reserved` + `trigger.fire.recorded` pair is
appended before the same transaction commits. Thus there is never a committed
`inFlightFireId` without its Fire row or a committed Fire row without the parent
reservation. Fact payloads carry IDs, status/cause, revisions, and canonical
payload digests rather than duplicating erasable prompt/output text.

The trigger facts live on `trigger:<triggerId>`. Fire status facts live on
`trigger_fire:<fireId>`. `packages/protocol/src/ledger/streams.ts` must add both
stream entries and the fact-type lists. These are revision-bound streams:
trigger revision is the head of `trigger:<id>`, and fire revision is the head of
`trigger_fire:<fireId>`. There is no pre-cutover Trigger row to adopt. An empty
stream at a nonzero revision is a real conflict, not permission to fabricate a
genesis from the legacy `cron_job` table.

#### Paired revision protocol

Let `P` be the current parent Trigger head and `F` the current Fire head. The
projection revision is always the committed stream head; no intermediate
revision is visible outside the transaction:

| Operation | Parent facts, in order | Child facts | Resulting heads |
| --- | --- | --- | --- |
| create | `trigger.created` | none | `P = 1` |
| restore watermark only | `trigger.restored` | none | `P + 1` |
| ordinary reserve | `trigger.fire.reserved` | `trigger.fire.recorded` | `P + 1`, new `F = 1` |
| terminal reserve | `trigger.fire.reserved`, then `trigger.ended` | `trigger.fire.recorded` | `P + 2`, new `F = 1` |
| ordinary coalesce | `trigger.fire.coalesced` | none | `P + 1` |
| terminal coalesce | `trigger.fire.coalesced`, then `trigger.ended` | none | `P + 2` |
| attempt/delivered | none | one corresponding child fact | `F + 1` |
| ack without pending | `trigger.fire.released` | `trigger.fire.acked` | `P + 1`, `F + 1` |
| ack with pending | `trigger.fire.released`, then `trigger.fire.reserved` | `trigger.fire.acked`, then the next `trigger.fire.recorded` | `P + 2`, old `F + 1`, new `F = 1`; an ended parent's pending batch already has its single `trigger.ended` fact from the earlier terminal/expiry transition |

The exact append interleaving between the parent and child streams is fixed by
the store implementation, but all listed facts and projection CASes share one
immediate transaction. A fact's `revision` is stream-local; parent and child
revisions are not expected to be numerically equal. A retry after an unknown
outcome reads both heads and uses the existing identity/digest receipts; it
never appends a second fact for the same operation. This is the reason a parent cannot expose an
`inFlightFireId` without its Fire row, and a Fire cannot become acknowledged
without the parent release.

### 2.6 Typed errors

`Trigger.StoreError` follows `Wait.StoreError` and uses `NamedError.create`.
Its stable codes are:

```text
adapter_absent
unavailable
duplicate
not_found
revision_conflict
invalid_transition
active_cap
corrupt
admission_conflict
owner_session_missing
```

Ownership filtering is an app/tool concern. A trigger ID belonging to another
session is reported as `not_found`, not as a distinguishable authorization
error. `markDelivered` and `ack` are idempotent when the existing row already
carries the same or a later status and the same admission identity (fire,
session, message, and payload digest); they return the existing receipt rather
than raising `already_*`. A mismatch in any identity field raises
`admission_conflict`. Error messages are diagnostic only; callers branch on
`code`.

The session admission helper raises `owner_session_missing` only for the exact
owner session carried by an already-authorized Fire; it is not a general
session-existence oracle. The host maps it to the same durable pause reason.

App-owned preflight refusals use the separate closed set `command_invalid |
filter_invalid | path_invalid | source_unavailable | source_identity |
source_spawn | source_pipe`. They are returned as tool errors only while no
Trigger row exists and no source effect has started. The unavoidable race after
an armed row commits is different: an activation failure is recorded as
`paused(source_unavailable)` when retry is safe, or as `ended(source_error)`
with one terminal summary after a handle partially started. Once a row exists,
the tool returns that durable row identity/state instead of throwing an error
that could induce a duplicate create. Runtime `source_timeout`,
`source_exited`, `source_error`, and `cancelled` are durable lifecycle reasons,
not free-form error-code substitutes.

## 3. Pure scheduler fold

### 3.1 Interface

The protocol scheduler has no `Date.now`, `setTimeout`, randomness, storage,
Bus, process, or filesystem import. The app supplies all facts that could vary:

```ts
Trigger.Scheduler.step(
  state: Trigger.Record,
  input: Trigger.SchedulerInput,
): Trigger.SchedulerResult;
```

`SchedulerInput` is a discriminated union of:

- `timer_due { at, fireMaterial }`
- `source_observation { batch, at, terminalReason?, fireMaterial }`
- `delivery_acknowledged { fireId, at, admission, nextReservation? }`
- `pause { reason, at }`
- `rearm { at }`
- `cancel { at, detail?, terminalBatch?, fireMaterial? }`
- `source_closed { reason, at, detail?, terminalBatch, fireMaterial }`
- `restore { at, fireMaterial? }`

`terminalBatch` is the bounded `{ items, overflowCount, firstAt, lastAt,
terminalReason }` produced by the notifier, and is required for every event
source closure; a time-source `cancel` has no batch. A
`source_observation` carrying a summary is likewise terminal only when its
`terminalReason` is explicit; the fold never infers a lifecycle transition from
summary prose. This makes exit, timeout, safety, and cancellation races use one
atomic reserve/coalesce-plus-end operation.

Identifier, trace, and rendered-payload facts are supplied by the host rather
than minted by the fold. `fireMaterial` contains both a parsed
`Trigger.FireReservation` and the equivalent parsed `Trigger.PendingBatch`.
The fold chooses the reservation when no Fire is in flight and the batch when
one is; it validates that source items, overflow, terminal reason, schedule
instant, payload digest, IDs, and trace describe the same observation. IDs in
the unused arm are simply discarded. There is no host-side alternate
transition.

For acknowledgement, `nextReservation` is required exactly when the snapshot
has `pendingBatch`; it carries that batch's fingerprint plus the app-minted
reservation for the replacement Fire. The store compares the expected parent
revision and fingerprint in the acknowledgement transaction. A concurrent
coalesce therefore causes `revision_conflict`; the host rereads and rebuilds
the reservation instead of letting ledger invent an ID or render product
content.

A result is a new immutable record plus pure effects such as `reserve_fire`,
`arm(dueAt)`, `cancel_timer`, `pause_source`, or `end`. The ledger transition
surface invokes this fold against the current row and commits the result; only
the committed result and effects return to the app, which then executes those
effects. A timer input is valid only for a time source, a source observation or
closure only for an event source, and an acknowledgement only for the current
`inFlightFireId`; a mismatched input is `invalid_transition` with no state
change. The fold also rejects a terminal batch whose reason does not match the
source and parent lifecycle transition.

### 3.2 Clock and timer rules

The app's clock port is:

```ts
interface TriggerClock {
  now(): number;
}

interface TriggerTimerPort {
  arm(key: string, dueAt: number, callback: () => void): void;
  cancel(key: string): void;
  cancelAll(): void;
}
```

`arm` replaces the previous handle for the same trigger key. The host also
checks a generation token in the callback, so a stale callback cannot consume a
new schedule. There is never more than one armed deadline timer for a trigger.
The notifier has one coalesce/rate timer per owner session. Each file source
has one `FILE_SAFETY_POLL_MS` liveness handle in addition to its scheduler
state. That poll is not another Trigger deadline: it may request the same
identity check as an `fs.watch` callback, but only a safe, accepted check can
produce the scheduler observation that reserves a Fire.

`setTimeout` cannot represent a delay above `SET_TIMEOUT_MAX_MS` (about 24.8
days). The app timer adapter implements a re-arm chain:

```text
rawNow = clock.now()
logicalNow = max(rawNow, lastObservedAt)
remaining = dueAt - logicalNow
if remaining <= 0: invoke the scheduler callback
else arm(min(remaining, SET_TIMEOUT_MAX_MS))
when the segment fires: re-read the clock and repeat
```

The callback always re-enters the pure fold; it never assumes that the segment
was the actual deadline. A long once alarm therefore survives timer overflow
without an early fire or a lost fire. The source timeout, when applicable, uses
this same per-Trigger deadline handle; it does not introduce a second Trigger
deadline timer. Pausing cancels a time-source schedule, but a finite event
source keeps this absolute timeout armed while paused; wake suppression cannot
turn a five-minute source into an unbounded process.

For a wall-clock rollback, the host passes `logicalNow = max(clock.now(),
lastObservedAt)` and records an operational warning. A clock rollback cannot
move `nextFireAt` backwards or cause an early fire. A forward jump is handled
as ordinary lateness and is subject to the once/recurring rules below.

### 3.3 Due and coalescing algorithm

For a `time.every` timer callback:

1. If the trigger is `ended` or `paused`, cancel the stale handle and do
   nothing.
2. If `logicalNow < nextFireAt`, re-arm the same deadline; no fire is made.
3. If `logicalNow >= expiresAt`, end `expired` without a new fire. The
   boundary is inclusive through `Deadline.isExpired` (`now >= deadline`). A
   fire at expiry is not legal. If an earlier Fire is in flight, retain it for
   delivery and clear any ordinary pending batch in the same lifecycle CAS;
   ending the Trigger never clears an unacked Fire.
4. If an unacked `inFlightFireId` exists, set `coalescedFirePending = true`,
   merge a bounded pending batch, and set `nextFireAt` to the checked next
   occurrence described below. With no source data, merge an empty schedule marker
   (`scheduledForAt = the consumed nextFireAt`, `firstAt = lastAt =
   logicalNow`). Persist that merge through the same
   `TriggerStore.transition` call before returning. No second Fire row is
   created.
5. Otherwise reserve one fire with `scheduledForAt = nextFireAt` and
   `firedAt = logicalNow`, set `inFlightFireId`, and immediately recompute the
   checked next occurrence.
6. In either branch, if the recomputed deadline is at or after expiry, append
   `ended(expired)` after accepting the current occurrence. A reserved Fire
   still delivers; a coalesced schedule marker may drain once after the older
   Fire is acknowledged. No observation at or after expiry is accepted.

The important basis is `logicalNow`, never `oldDueAt`. The fold computes the
next value without overflow as
`interval >= expiresAt - logicalNow ? expiresAt : logicalNow + interval`.
Reaching `expiresAt` takes the terminal branch in step 6. A sleeping laptop or
a long Resident turn therefore produces one catch-up fire, not one fire per
missed period.

For `time.once`, the source's `at` is the due instant. It has no absolute
expiry. A callback at or after `at` reserves exactly one fire and ends the
trigger `completed` in the same trigger/fire reservation transaction. A late
once alarm therefore fires once rather than being discarded as expired. A
second timer callback sees the ended record and cannot create another row.

For an event observation, the notifier decides whether an item belongs in an
emitted batch. If the trigger has no in-flight Fire, the scheduler reserves one
Fire. If it has one, it sets the pending bit and stores the bounded batch through
the durable `TriggerStore.transition` operation. On acknowledgement, the
scheduler clears the in-flight ID and, in the same durable transition, reserves
at most one pending Fire from the app-supplied, fingerprint-pinned reservation.
The pending bit is not cleared until that replacement Fire is
durably recorded, even when the parent is already terminal. Once a terminal
transition wins, ordinary pending lines are discarded. Only the terminal batch
that caused a source transition, or a recurring marker accepted before an
expiry transition, may drain after the prior Fire while the parent remains
`ended`.

A delivery failure is handled by the app delivery host, not by a second
Trigger-record transition: the durable attempt fact and unchanged unacked Fire
are already its retry receipt. It does not create a replacement Fire or end the
Trigger. The same Fire ID remains in flight and is retried with exponential
backoff `min(DELIVERY_RETRY_MAX_MS, DELIVERY_RETRY_BASE_MS *
2**min(attempt-1, 16))` until admission succeeds or an explicit terminal
owner/source condition pauses it. There is no attempt-count terminal; durable rows are the recovery
work list. A terminal source input is handled as one store operation: the final
summary is reserved or coalesced first, then the `ended(reason)` lifecycle fact
is appended in that same transaction. A source may end while its final summary
Fire is in flight; no new ordinary line Fire may be reserved after the end.

### 3.4 Transition table: trigger lifecycle

| Current | Input and guard | Next state | Durable/action result |
| --- | --- | --- | --- |
| absent | preflight-valid create and fewer than five indexed non-ended rows for the owner | `armed` | append `trigger.created`; activate source/deadline only after commit |
| absent | active count is five | absent | typed `active_cap`; no row, timer, or source |
| `armed` | post-commit source activation is temporarily unavailable | `paused(source_unavailable)` | append `trigger.paused`; close any partial handle; return the durable trigger receipt |
| `armed` | wake-budget, missing-owner, or recovery-conflict pause | `paused` | append `trigger.paused`; cancel a time schedule but retain a finite event-source timeout; retain in-flight/pending Fire |
| `paused` | `rearm` passes preflight | `armed` | append `trigger.rearmed`; activate after commit; recurring schedule is recomputed from now; once due is retained |
| `paused` | post-commit rearm activation is still unavailable | `paused(source_unavailable)` | append a new pause only if the rearm committed; close any partial handle and return the durable state |
| `armed` or `paused` | `cancel` | `ended(cancelled)` | event sources replace ordinary pending work with one cancellation summary; time sources discard an unreserved schedule marker; append `trigger.ended`, then stop the source; existing Fire rows remain deliverable |
| `ended` | `cancel` | `ended` | idempotent read; no second terminal fact |
| `armed` or `paused` | restore before any deadline, with no due occurrence | same lifecycle | append `trigger.restored`, advance `lastObservedAt`, and return only lifecycle-appropriate arm effects |
| `armed` or `paused` | recurring restore/rearm observes `Deadline.isExpired(logicalNow, expiresAt)` | `ended(expired)` | append `trigger.ended`; no fire at/after expiry |
| `armed` | once due observed | `ended(completed)` | reserve the one fire and end in the same transaction |
| `armed` or `paused` | file match accepted | `ended(completed)` | emit match and terminal summary as priority completion; reserve the terminal sequence before ending |
| `armed` | command exits normally or nonzero | `ended(source_exited)` | emit an exit summary; no more source lines |
| `armed` or `paused` | finite event-source deadline reached | `ended(source_timeout)` | reserve/coalesce the timeout summary before stopping the source |
| `armed` | source identity/safety violation | `ended(source_error)` | stop source; emit a terminal error summary and no replacement source |
| `paused` | source exits or reports a safety error | corresponding `ended(reason)` | terminal summary still bypasses notifier suppression; no ordinary paused lines are replayed |
| `ended` | a losing exit/timeout/cancel callback | `ended` | terminal latch makes it a no-op; reap/cleanup only, with no second summary |
| `ended` | any timer, line, or rearm callback | `ended` | no-op; no new fire and no handle |

Cancel never deletes or suppresses an already-recorded Fire. It does discard a
time source's not-yet-recorded schedule marker; event-source pending work is
replaced by the mandatory cancellation summary, so no ordinary source line can
arrive after cancellation.

Pause effects are reason-specific. `wake_budget` keeps an existing command/file
handle alive and draining while suppressing ordinary observations;
`source_unavailable` has no usable handle; and `owner_session_missing` or
`recovery_conflict` closes any live handle without fabricating a terminal
summary. Source identity/safety faults instead record a mandatory summary and
end `source_error`. Every finite event pause retains only its
absolute timeout timer. Rearm repeats source activation for a closed handle but
may reuse a still-live wake-budget handle.

`paused` counts against the active cap. Pausing cannot be used to create an
unbounded number of dormant triggers. `ended` rows remain in the ledger and do
not count against the cap.

### 3.5 Transition table: fire lifecycle

| Current fire status | Input and guard | Next status | Rule |
| --- | --- | --- | --- |
| none | reservation passes parent CAS and fire insert | `recorded` | both facts/projections commit before delivery is called |
| `recorded` | delivery attempt is claimed | `recorded` | increment durable attempt count; stable fire ID is retained |
| `recorded` | internal delivery is accepted | `delivered` | CAS only; a conflict reads the existing status |
| `delivered` | Resident admission receipt exists | `acked` | CAS only after session/message commit |
| `recorded` | delivery fails | `recorded` | retain row and retry; never pretend delivery occurred |
| `delivered` | process crashes before ack | `delivered` | boot re-pushes the same fire; Resident admission is idempotent |
| `acked` | duplicate delivery/ack | `acked` | return an idempotent receipt; no second session message or fact |
| any | mismatched fire/trigger/owner or stale revision | unchanged | typed refusal; no action is taken |

There is no `failed` fire status. An unknown delivery result is deliberately
not interpreted as failure; the unacked row is the recovery work item.

### 3.6 Scheduler invariants

These are asserted by the fold and its tests, not left to app discipline:

- one armed timer key per trigger;
- at most one unacked fire per trigger, represented by `inFlightFireId`;
- at most one durable coalesced pending batch while that fire is in flight;
- no fire at or after a recurring expiry;
- a once alarm is not discarded for lateness and cannot fire twice;
- recurring next deadlines are computed from the current logical time with
  checked safe-integer arithmetic;
- every non-terminal boot restore advances `lastObservedAt` before any handle
  is armed; a no-other-change restore uses `trigger.restored`, while a due,
  expiry, or pause transition uses its more specific parent fact;
- a paused time trigger has no schedule timer; a paused finite event trigger
  retains only its absolute timeout timer, and a persistent event trigger has
  no deadline. Paused event handles may remain alive and drain for pipe safety,
  but ordinary observations are suppressed and durable pending work is
  preserved;
- a terminal trigger cannot be resurrected by boot or `trigger_rearm`;
- every effect is downstream of a successfully persisted fold result.

## 4. Pure notifier fold

### 4.1 State and inputs

The notifier is one instance per owner session. Its state is ephemeral
suppression state, not authority and not the fire ledger:

```ts
Trigger.Notifier.State = {
  pending: readonly Trigger.Notifier.Event[],
  eventChars: number,
  overflow: Readonly<Record<string, number>>, // triggerId -> count
  lastInjectionAt: Readonly<Record<string, EpochMs>>,
  lastBatchFingerprint: Readonly<Record<string, string>>,
  consecutiveWakes: number,
  lastWakeAt?: EpochMs,
  wakeBudgetPaused: boolean,
};
```

A notifier event is:

```ts
Trigger.Notifier.Event = {
  triggerId: string,
  kind: "line" | "summary",
  text: string,       // already sanitized and bounded
  at: EpochMs,
};
```

The pure operations are `observe`, `flush`, `noteActivity`, `rearm`, and
`dispose`. They return a new state and effects:

```text
schedule_flush(dueAt)
schedule_rate_limit(dueAt)
emit(triggerId, items, overflowCount, terminal, payload)
pause_event_triggers
```

The host stages each returned state/effect pair. Timer-only results install the
new state before scheduling their timer. Results containing `emit` or
`pause_event_triggers` keep the prior queue state retryable until the required
Trigger transaction commits, then atomically replace the in-memory state and
execute delivery effects. A revision conflict therefore rebuilds from fresh
rows without dropping the staged batch. A notifier emission becomes a
scheduler observation/reservation; it is not itself a successful fire. The host reads the Trigger, builds both arms of
`fireMaterial`, and calls `TriggerStore.transition` with the observed revision.
The store's fold reserves when no Fire is in flight and durably coalesces when
one is. Thus every follow-up accepted after the one-fire gate is durable before
the source callback is released. The two-second queue before an emission is
intentionally ephemeral suppression state; an observation that has not reached
the ledger is not represented as a Fire promise.

### 4.2 Exact suppression rules

1. **Coalesce:** the first event schedules a flush at `now +
   NOTIFIER_COALESCE_WINDOW_MS`. Later events do not move an already earlier
   flush. There is one notifier timer per owner session.
2. **Queue bounds:** admission is capped at 50 items and at
   `NOTIFIER_MAX_CHARS - QUEUE_OVERHEAD_CHARS` rendered characters, including
   per-item labels and separators. An ordinary
   line that does not fit increments `overflow[triggerId]`; it is not retained
   unboundedly. An overflow-only group still emits a bounded Fire containing
   the disclosed count. A terminal summary is never rejected by these queue
   bounds: it is emitted as a bounded summary-only batch if necessary, and
   deferred ordinary lines for that trigger are discarded under rule 10.
3. **Rate limit:** at flush, a trigger is ready when it has no prior injection
   or `now - lastInjectionAt[triggerId] >= NOTIFIER_RATE_LIMIT_MS`. Non-ready
   items remain queued and schedule the earliest next eligible time. If the gap
   since `lastWakeAt` exceeds `NOTIFIER_RATE_LIMIT_MS *
   WAKE_STREAK_QUIET_GAP_MULTIPLIER`, the consecutive wake streak resets before
   the next line-only injection. At a global flush, terminal-bearing groups are
   processed first in `(firstAt, triggerId)` order, then line-only groups in the
   same order; priority completion resets the streak before ordinary wakes are
   counted.
4. **Fingerprint:** a ready batch containing only lines and no overflow is
   fingerprinted as `canonicalDigest({ triggerId, lines })`, using the existing
   canonical JSON owner. If it equals the last injected fingerprint for that
   trigger, the batch is discarded without a wake. A batch with overflow or a
   summary is never fingerprint-suppressed.
5. **Terminal bypass:** a `summary` is ready regardless of the per-trigger rate
   limit or the two-second queue window, is not fingerprint-suppressed, does
   not consume wake budget, and resets the consecutive wake streak. This
   includes a source exit, timeout, safety error, and file-watch completion
   summary. A summary arriving during a global wake pause clears that pause for
   notifier purposes. The summary text itself is clipped to the source-item
   bound, never dropped.
6. **Wake budget:** a line-only injection increments the owner-session streak.
   The fifth consecutive line-only injection carries a pause notice and sets
   `wakeBudgetPaused`. Before delivering that Fire, the owner-serialized host
   commits its reserve/coalesce plus `pause(wake_budget)` for every currently
   armed event trigger in one `TriggerStore.transitionBatch`; already-paused
   rows retain their more specific reason. Only then does it execute the Fire
   delivery effect. A crash can therefore see all pauses or none, never a
   partially paused owner. If several line-only groups share one flush, the
   fifth is the last emitted and later ordinary groups are dropped under the
   new pause; terminal groups have already bypassed. Time alarms are priority
   Fires and are not included.
7. **Paused lines:** while `wakeBudgetPaused`, further line events are dropped
   rather than allowed to grow a hidden queue. A summary still passes the
   terminal bypass. Dropped paused lines are not falsely reported as overflow;
   overflow counts describe queue capacity loss only.
8. **Activity:** admission of an ordinary user-originated turn calls
   `noteActivity`, covering any tools that turn subsequently invokes, and
   resets the consecutive streak. A Trigger-originated turn never counts;
   otherwise a trigger storm could reset its own guard.
9. **Explicit rearm:** `rearm(triggerId)` clears the global notifier pause,
   resets the streak, and removes the selected trigger's last-injection and
   fingerprint entries. The scheduler separately changes that trigger from
   `paused` to `armed`. The first identical line after rearm is therefore
   eligible.
10. **Terminal ordering:** when a trigger's terminal summary is emitted, any
    deferred non-terminal lines for that trigger are dropped after the summary
    is reserved. The terminal fact is the final source report.

The fold groups output by trigger in stable arrival order. The host processes
emission effects in `(first item at, triggerId)` order, renders each group as a
separate Fire, and serializes it through that trigger's one-fire gate. It must not invent
a shared Fire ID belonging to several triggers.

### 4.3 Rendering and disclosure

The app renderer includes the complete stored prompt as intent and one
notifier block already bounded to `NOTIFIER_MAX_CHARS`. It labels source items
as untrusted observations and keeps all remaining trigger/fire framing within
`FIRE_ENVELOPE_CHARS`; the resulting payload therefore fits
`MAX_FIRE_PAYLOAD_CHARS` by construction. It does not apply a second final
clip. Individual source text is bounded before the fold, omitted queue items
are counted as overflow, and a terminal summary that cannot share the block is
rendered as the summary-only block. A violated arithmetic bound is `corrupt`,
not permission to truncate silently.

The renderer uses `canonicalDigest` for fingerprints and does not implement a
second JSON or hash codec. The exact prose is not a protocol promise; machine
fields are `triggerId`, `fireId`, `sourceItems`, `overflowCount`,
`terminalReason`, and `payloadDigest`.

A delivered overflow batch includes a machine-visible count and a short
human-readable disclosure such as "additional observations omitted". The count
is also persisted on `Trigger.Fire`. No claim is made that an omitted line was
seen by the Resident.

On process restart notifier suppression state is empty. This can repeat a line
batch produced by a freshly spawned persistent command, but it cannot duplicate
the session admission for the same fire ID. Avoiding that bounded, observable
at-least-once source behavior would require a durable notifier projection and
is not part of this slice.

## 5. App-owned event sources

All source effects live under `apps/openomni/src/trigger/sources/`. Protocol
never imports `node:child_process`, `node:fs`, or a shell.

### 5.1 Command source

`event.command` is an observation source, not an execution request from source
output. The app resolves `shell = process.env.SHELL?.trim() || "/bin/sh"`, preflights
that it is an executable file, and after the Trigger commit starts exactly:

```ts
spawn(shell, ["-lc", `exec 2>&1\n${command}`], {
  cwd: appWorkingDirectory,
  env: process.env,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
```

The `exec 2>&1` runs inside the child shell before the Owner command, so both
file descriptors write the one stdout pipe and ordering is not guessed by
merging two JavaScript callbacks. The stderr pipe is still drained defensively
and any unexpected bytes are treated as a source-pipe fault. The child is
started in its own process group; the source records the group leader PID only
in memory and terminates the negative group PID, never an unrelated process,
on timeout or cancellation. If the host cannot provide this process-group
boundary, preflight fails closed. The command is intentionally
Owner/Resident-authorized host work; it is not placed on an attached machine.

Rules:

- The regex is compiled before the trigger row is written. An invalid expression
  returns a typed source refusal and starts no process. There are no model-
  supplied flags; `new RegExp(filter)` is the one compilation rule.
- Stdout bytes pass through one `StringDecoder("utf8")`, so a multibyte code
  point split across chunks is not corrupted. Decoded characters are accumulated
  until `LF`, but the unfinished buffer is capped at
  `MAX_PARTIAL_LINE_CHARS`. Once that cap is reached the driver keeps a clipped
  marker and discards decoded characters until the next `LF`; it never grows
  memory on a newline-free stream. A trailing partial line at process exit is
  discarded, matching the line-oriented monitor precedent. A preceding `CR`
  is removed from a complete `CRLF` line.
- Only complete, sanitized lines matching the filter become `line`
  observations. Each emitted text is bounded to `MAX_EVENT_TEXT_CHARS`; without
  a filter every complete line is eligible. Output is drained even while a
  trigger is paused so a paused process cannot back up the pipe; paused lines
  are discarded by the notifier.
- `persistent: false` applies `SOURCE_TIMEOUT_MS` and otherwise runs until the
  child exits. `persistent: true` has no app deadline and runs until exit or
  cancellation. Persistent is therefore the explicit choice for long-lived
  streams; it grants no restart reattachment or resurrection semantics. On timeout,
  the host first durably records a terminal timeout summary and ends the
  Trigger, then sends `SIGTERM` to the spawned process group, waits exactly
  `SOURCE_KILL_GRACE_MS`, and sends `SIGKILL` if the group remains. The same
  termination sequence is used after the durable cancellation summary. Reaping
  is cleanup; failure to reap publishes an operational error and never creates
  another Fire.
- One serialized terminal latch owns exit, timeout, cancellation, and startup
  fault races. A spawn refusal before a process group exists is safely
  retryable: the already-created Trigger is paused `source_unavailable` and no
  summary is fabricated. Once a process group or pipe exists, the winning
  terminal transition produces exactly one summary; a normal/nonzero exit
  summary names the exit status and code when available. Timeout and
  cancellation use their lifecycle reasons; pipe/startup failures end
  `source_error` with bounded typed detail (`source_pipe` or `source_spawn`). A
  later child-exit callback after timeout or cancellation only reaps the process
  and cannot create a second summary or ordinary Fire. The
  winning exit path forces all already-framed lines and the summary through one
  terminal notifier handoff; if a Fire is already in flight, that batch is
  written to durable pending state before the source callback returns.
  `trigger_cancel` records its cancellation summary before sending a signal.
- Normal exit ends the trigger `source_exited`; timeout ends it
  `source_timeout`; cancellation ends it `cancelled`. A fault after process
  ownership is established ends it `source_error`; a pre-handle spawn refusal
  follows the retryable pause rule above. A final summary already observed is allowed to finish
  its fire after the lifecycle becomes terminal.
- On notifier wake-budget pause, the child remains alive, output is drained and
  line observations are suppressed. `trigger_rearm` resumes that handle if it
  is still live. If it has exited, its summary/terminal state wins and the
  trigger is not resurrected.

The process handle, PID, shell path, and line buffer are not persisted. The
only durable delivery promise is a Fire returned by a committed
`TriggerStore.transition`. A hard host death is not a cleanup callback: on a
platform where the detached process group outlives its parent, that group is an
orphan this subsystem cannot safely identify or signal after restart. Boot
still starts a fresh child from durable configuration. Production supervision
should place the app and descendants in one kill domain; without that external
boundary, duplicate command side effects after a crash are an explicit risk,
not a claimed exactly-once behavior.

### 5.2 File source

`event.file` watches a local path and is deliberately stricter than a plain
`fs.watch(path)` call. Registration and every candidate change use this order:

1. Resolve the requested path against the app working directory. Reject empty,
   NUL-containing, or otherwise unparseable paths at the app boundary.
2. Resolve and pin `realpath(dirname(path))` as `canonicalParent`. A missing
   parent is a source-unavailable refusal; the watcher never watches a path
   through an unresolved parent.
3. If the target exists, `lstat` it and reject a symlink. Open it with the
   platform `O_NOFOLLOW` flag, `fstat` the handle before reading, and require a
   regular file; if the flag is unavailable, registration fails closed. Resolve
   the target and require exactly `join(canonicalParent, basename(path))`. A
   descriptor that fails any identity check is never exposed to the notifier.
4. For `on: "modify"`, a regular target must exist at registration and its
   device/inode become the pinned identity. For `on: "create"`, initial
   preflight requires the target to be absent; an already-present target is a
   typed `source_identity` refusal with no row. The first accepted regular file
   after the durable create supplies the identity.
5. Watch the pinned real parent, filter notifications to the target basename,
   and perform the complete safety sequence again before reading or emitting.
6. Re-check the parent realpath. A changed parent ends the source with
   `source_error`; the new parent is never followed automatically.
7. Re-check `lstat` and `realpath` for the target. A symlink, a target
   resolving outside the pinned parent, a non-regular file, or a device/inode
   mismatch ends the source with `source_error`. A replacement is not silently
   adopted. For `on: "modify"`, disappearance after registration is also an
   identity error; it is not treated as a quiet no-op.
8. For an accepted regular file, compare presence, `mtimeMs`, size, and a
   bounded content digest. The digest samples the first, middle, and last
   `FILE_DIGEST_SAMPLE_BYTES` for files larger than one sample, using SHA-256;
   it is a change detector, not an authorization proof. A `create` fires on
   the first safe present state after its durable absent preflight, including
   activation or boot recovery before the watcher is installed. A `modify`
   fires only when an existing file's metadata
   or digest changes.
9. Re-check device/inode after the digest and close the handle. A race during
   the read is an identity error, not a possibly-valid event.
10. An accepted change emits one line observation (`create ${JSON.stringify(path)}`
    or `modify ${JSON.stringify(path)}`) and one terminal `summary`
    (`watcher completed`) as one
    terminal source batch. The host forces that batch through the notifier so
    the summary cannot be fingerprint- or rate-suppressed; it then closes the
    watch and ends `completed`. Every other source closure (timeout, identity
    error, watcher error, or cancellation) records one terminal summary before
    ending with its corresponding reason. Cancellation records that summary
    before closing the watch; a timeout ends `source_timeout`.

A concurrent filesystem callback while a check is running sets one dirty bit.
At most one immediate recheck (`FILE_DIRTY_RECHECK_LIMIT`) is performed after
the current check; further callbacks collapse. The production source uses the
`FILE_SAFETY_POLL_MS` safety poll as a liveness supplement, but tests call the
check operation directly through an injected port and never sleep for timing
luck.

Creation is explicitly two-phase. Preflight performs steps 1-4 and opens only
short-lived validation descriptors; it installs no watcher and emits no event.
After the `trigger.created` transaction, activation repeats the identity checks
to close the race and then performs step 5. A safe regular target that appeared
for `on: "create"` in that interval is the requested event: reserve its terminal
batch immediately and install no watcher. A preflight failure returns a typed
tool error because no row exists. Any other activation failure never erases
that committed row: a temporarily missing parent or watcher-capacity failure
closes every partial handle and pauses `source_unavailable`; an unsafe identity
change between preflight and activation records one safety summary and ends
`source_error`.
The create/rearm tool returns the resulting durable identity and state.

A boot-time parent that is temporarily absent follows the same retryable pause
path. Explicit rearm repeats all safety checks, but it is not a new tool-create
preflight: for an already-durable `on: "create"` trigger, safe presence is the
requested event and completes immediately. A post-registration identity
violation is terminal `source_error`, because following a replacement would
weaken the safety boundary.

## 6. Ledger stores and migration

### 6.1 Raw storage interfaces

Add these interfaces to `packages/protocol/src/storage/index.ts`:

```ts
export interface TriggerListFilter {
  readonly ownerSessionId?: string;
  readonly states?: readonly Trigger.LifecycleState[];
  readonly kinds?: readonly Trigger.KindName[];
  readonly order?: "oldest" | "newest"; // default oldest
  readonly limit?: number; // 1..MAX_TRIGGER_LIST_ROWS
}

export interface TriggerFireListFilter {
  readonly triggerId?: string;
  readonly ownerSessionId?: string;
  readonly statuses?: readonly Trigger.FireStatus[];
  readonly limit?: number; // 1..MAX_TRIGGER_LIST_ROWS
}

export interface TriggerSubAdapter {
  create(record: Trigger.Record): boolean;
  get(id: string): Trigger.Record | undefined;
  list(filter?: TriggerListFilter): Trigger.Record[];
  // Indexed scans do not decode data; recovery then calls get(id) per row so
  // one corrupt JSON value cannot abort the whole sweep.
  listIds(filter?: TriggerListFilter): string[];
  listActiveIds(): string[]; // indexed state <> 'ended', ordered createdAt,id
  countActiveByOwner(ownerSessionId: string): number;
  compareAndSet(id: string, expectedRevision: number, record: Trigger.Record): boolean;
}

export interface TriggerFireSubAdapter {
  create(record: Trigger.Fire): boolean;
  get(id: string): Trigger.Fire | undefined;
  list(filter?: TriggerFireListFilter): Trigger.Fire[];
  compareAndSet(id: string, expectedRevision: number, record: Trigger.Fire): boolean;
  listUnackedIds(): string[];
}
```

The interfaces are storage receipts, not product decisions. Adapters parse on
write and record reads. Trigger list order is `(createdAt,id)` ascending for
`oldest` and descending for `newest`; Fire list order is `(recordedAt,id)`
ascending. They never silently repair malformed JSON. `listIds`,
`listActiveIds`, and `listUnackedIds` read only indexed ID/order
columns; `listUnackedIds` includes both `recorded` and `delivered`, oldest
first. The boot host gets each candidate separately and can report one corrupt
row while continuing unrelated recovery. `countActiveByOwner` counts every
indexed state other than the exact terminal value `ended`; malformed states
therefore consume capacity instead of opening a bypass.

Add optional `trigger` and `triggerFire` capabilities to `Storage.Adapter` for
narrow test fakes and add both to `requiredProductionCapabilities`.
`Storage.assertComplete` also structurally requires
`message.admitInternalTrigger` on a branded production adapter. Missing
production wiring is rejected at configuration; an unbranded fake reaches a
typed `adapter_absent` store error.

### 6.2 High-level store API

Create `packages/ledger/src/trigger/index.ts` with two public namespaces. The
API takes expected revisions explicitly; product rendering and identifier
allocation remain app inputs.

`TriggerStore`:

```text
create(input: Trigger.Create, traceId) -> Trigger.Record
get(id) -> Trigger.Record | undefined
list(filter?) -> Trigger.Record[]
listActiveIds() -> string[]
transition({
  triggerId,
  expectedRevision,
  input: Exclude<Trigger.SchedulerInput,
    { type: "delivery_acknowledged" }>,
  traceId
}) -> { trigger: Trigger.Record, fire?: Trigger.Fire, effects: SchedulerEffect[] }
transitionBatch(requests: readonly TransitionRequest[]) -> readonly TransitionReceipt[]
```

`TriggerFireStore`:

```text
get(fireId) -> Trigger.Fire | undefined
list(filter?) -> Trigger.Fire[]
listUnackedIds() -> string[]
claimDeliveryAttempt({ fireId, expectedFireRevision, traceId, at }) -> Trigger.Fire
markDelivered({ fireId, expectedFireRevision, traceId, at }) -> Trigger.Fire
ack({
  fireId,
  expectedFireRevision,
  expectedTriggerRevision,
  admission,
  nextReservation?: { pendingFingerprint, reservation },
  traceId,
  at
}) -> { fire: Trigger.Fire, trigger: Trigger.Record, nextFire?: Trigger.Fire }
```

`TriggerStore.transition` is the one persistence host for the pure scheduler
fold. It reads the current row inside the transaction and normally requires
`current.revision === expectedRevision`. Before reporting a conflict it checks
only two exact operation receipts: an existing Fire with the requested ID,
trigger, and payload digest plus the matching parent gate; or an existing
pending batch with the requested fingerprint. An exact receipt returns the
committed result idempotently with no fact replay; an unacked Fire may return
its replay-safe enqueue effect under the same ID. Every other mismatch is
`revision_conflict`. It then folds the supplied input, persists all resulting
parent/child changes, and returns effects only after commit.
`transitionBatch` is the same operation over at most
`TRANSITION_BATCH_CAP` (six) ordered requests in one immediate transaction; a
trigger may appear twice with sequential expected revisions. Its only
first-slice caller is the notifier's fifth-wake path: one emission
reserve/coalesce followed by `pause(wake_budget)` for at most five currently
armed owner event triggers. Any refusal rolls the whole batch back. A stale
request without one of those exact receipts causes the app host to read fresh
state, rebuild any app-owned Fire material, and call once more through its
per-trigger serialization queue; it never blindly overwrites a row.

`ack` is the one composite operation that appends the child ack and parent
release. There is no separately callable `releaseAfterAck`. An already-acked
Fire with the same admission short-circuits before checking or mutating the
parent, whose gate may now belong to a replacement Fire. When pending work
exists, `nextReservation` is mandatory and its fingerprint must equal the
current pending fingerprint; when no pending work exists it must be absent.
The expected parent revision closes the read/build/write race. Ledger therefore
never invents a Fire ID, trace, or rendered payload, and a caller cannot
acknowledge while stranding the Trigger gate or silently dropping a changed
batch.

Store mechanics use the existing `runCommitTransaction` and `commitFact`
patterns:

- `create` counts indexed non-ended rows for `ownerSessionId` and inserts the
  new row in the same immediate transaction as `trigger.created`; the
  five-trigger cap therefore holds under concurrent creates. `input.at` is the
  sole creation clock fact. The append uses expected head zero and the
  projection starts at revision one. It does not inspect or backfill
  `cron_job`.
- A transition (or each ordered member of `transitionBatch`) folds from the
  current parsed row, appends each typed parent fact at the preceding head, and
  advances the projection once per fact. A boot `restore` that has no due,
  expiry, pause, or reservation mutation appends `trigger.restored`; a restore
  that does mutate uses those more specific fact(s) instead, so every accepted
  restore advances `lastObservedAt` exactly once without redundant history.
  Multi-fact transitions may expose intermediate revisions only inside the
  enclosing immediate transaction; every intermediate row parses, and no
  other connection can observe it. Rejected folds write nothing.
- A reservation appends the parent reservation and child recorded facts,
  inserts the Fire, and updates the parent in one transaction. Whenever the
  same scheduler result also ends the parent (terminal source or recurring
  expiry), the matching `trigger.ended` fact is appended there as well.
  If either stream CAS or projection receipt refuses, the outer transaction
  rolls every append and row write back and no delivery effect returns.
- A coalesce appends the parent fact and CASes the bounded pending projection.
  An exact fingerprint retry is a no-write receipt; a different batch at a
  stale revision conflicts. It is the durable handoff for a follow-up
  observation; the host never leaves
  post-gate accepted work only in memory.
- `claimDeliveryAttempt` appends its child fact and increments the attempt
  count. `markDelivered` means the internal route/delivery seam accepted the
  stable Fire ID. Both use child revision CAS. An already-delivered or acked
  row with matching identity returns idempotently without another fact.
- `ack` validates the immutable admission, appends the child ack and parent
  release, and clears the in-flight gate. With pending work it then appends the
  app-supplied next reservation/recorded pair before commit. The local pending
  value may be cleared in an intermediate parent revision inside the
  transaction, but no committed state can expose a pending bit without a Fire
  gate or lose it without the replacement Fire.
- `runCommitTransaction` maps `SQLITE_BUSY` to `Trigger.StoreError(code:
  "unavailable")`; all other database errors propagate. No warning-and-return
  path is allowed for a missing adapter or failed append.
- Bus projections publish strictly after the durable transaction, in fact
  order. `Bus.publish` is never the record-before-act boundary.

The app imports `TriggerStore`/`TriggerFireStore` from `@openomni/ledger`, not
`Storage` internals or SQLite adapters. Each store begins with `Storage.get()`
and therefore preserves the existing exact fail-closed error
`Storage.get() called before initialize()`; it never creates a `:memory:`
adapter. Source and delivery code cannot write a row directly.

### 6.3 SQLite projection schema

Add the forward migration
`packages/ledger/migration/0030_trigger_subsystem/migration.sql` after
`0029_provisioning`:

```sql
CREATE TABLE IF NOT EXISTS trigger_record (
  id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL,
  expires_at INTEGER,
  next_fire_at INTEGER,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trigger_record_owner_state
  ON trigger_record(owner_session_id, state, time_created, id);

CREATE INDEX IF NOT EXISTS idx_trigger_record_due
  ON trigger_record(state, next_fire_at);

CREATE TABLE IF NOT EXISTS trigger_fire (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES trigger_record(id) ON DELETE CASCADE,
  owner_session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trigger_fire_trigger_time
  ON trigger_fire(trigger_id, time_created, id);

CREATE INDEX IF NOT EXISTS idx_trigger_fire_status_time
  ON trigger_fire(status, time_created, id);

CREATE INDEX IF NOT EXISTS idx_trigger_fire_owner_status
  ON trigger_fire(owner_session_id, status, time_created, id);
```

`trigger_record` is used instead of the SQLite keyword `trigger`. The JSON
`data` column is the complete parsed row; indexed columns are query projections
and must agree with it on read. There is intentionally no foreign key from
`owner_session_id` to `session`: trigger cancellation/expiry must not silently
cascade session content, and the existing gateway domain rules keep opaque
session bridges free of cross-domain FK coupling.

Update, in one migration-aware change:

- `sqlite-schema-lifecycle.ts`: append `0030_trigger_subsystem` to
  `ORDERED_MIGRATIONS` and place `trigger_fire` before `trigger_record` in
  `CLEAR_ORDER`.
- `sqlite-storage.ts`: construct and expose the two SQLite adapters.
- `sqlite-trigger-adapter.ts` and `sqlite-trigger-fire-adapter.ts`: use prepared
  statements, `INSERT OR IGNORE` receipts, revision CAS, strict row parsing,
  and deterministic ordering.
- `storage.ts`: add the two capabilities and production completeness checks.
- `packages/ledger/src/index.ts`: export the two store namespaces.

The old `0004_cron_job` migration and its table remain historical in this
slice. No old row is guessed into a Trigger: the old row has no unified source,
owner-session, fire, or lifecycle contract. `clearSqliteStorage` continues to
empty the old table because current cleanup owns that residue, but no Trigger
reader or writer touches it.

### 6.4 Memory/SQLite parity

Production remains SQLite-only; there is no silent in-memory fallback. For
isolated tests, add a Map-backed pair in
`packages/ledger/test/trigger/memory-trigger-adapters.ts`, following
`packages/ledger/test/delegation/memory-delegation-adapter.ts`;
`packages/ledger/test/helpers/trigger.ts` holds parsed fixture builders only.
The adapter pair must:

- parse every create, CAS, and read through `Trigger.Record`/`Trigger.Fire`;
- clone returned values so a caller cannot mutate stored state;
- implement the same duplicate, CAS, status, ownership-neutral, and sort rules;
- expose an injectable transaction wrapper that can roll back scripted writes;
- retain Fire rows and return recorded plus delivered IDs from
  `listUnackedIds` in the same deterministic order.

The ledger store contract suite runs the same cases against the Map pair and a
real `SqliteStorageAdapter`. A separate migration suite proves fresh creation,
reopen persistence, idempotent second application, and that legacy `cron_job`
rows are neither read nor converted.

## 7. Internal delivery and Resident admission

### 7.1 Internal event shape

The app builds one stable internal event per fire:

```ts
{
  id: fire.id,
  traceId: fire.traceId,
  surface: "internal",
  mode: "internal",
  agentName: "resident",
  target: { kind: "resident", sessionId: fire.ownerSessionId },
  payload: fire.payload,
  meta: {
    actor: { role: "system", id: "system:trigger" },
    kind: "trigger.fire",
    triggerId: fire.triggerId,
    fireId: fire.id,
  },
  activation: {
    trigger: {
      kind: fire.scheduledForAt === undefined ? "internal" : "cron",
      id: fire.triggerId,
      fireId: fire.id,
      scheduledAt: fire.scheduledForAt,
      firedAt: fire.firedAt,
      attempt: fire.deliveryAttempts,
    },
  },
}
```

`fireId` is added to the typed activation trigger shape rather than hidden in
an untyped field. The event is wrapped in an internal `Gateway.InternalDeliver`
with `sessionId = fire.ownerSessionId`. Its route decision is exact:
`mode = "internal"`, `stage = "surface_default"`, `outcome = "route"`,
`inboundId = fire.id`, `target = "resident:<ownerSessionId>"`, and
`sessionId = fire.ownerSessionId`; `factsUsed` names `trigger:<id>` and
`trigger_fire:<id>`. The event and decision carry `fire.traceId`; the decision
uses `time = fire.recordedAt`, while `activation.trigger.firedAt` remains the
source observation time. Those timestamps are facts from the immutable Fire,
not newly minted delivery state.

The route stream uses the existing scoped `Ingress.routeStreamId` with the
stable fire event ID. On a replay conflict, the fresh internal decision must be
equivalent to the recorded decision or delivery fails closed. No channel grant,
blacklist, Wait, or external actor lookup runs on this arm.

### 7.2 Admission boundary

The current Resident function combines session admission and model execution.
The implementation slice makes those private phases explicit without creating
a second Resident, and exposes one acknowledgement seam for the internal arm:

```ts
interface ResidentDelivery {
  deliver(delivery: Gateway.ExternalDeliver): Promise<Ingress.IngressResult>;
  deliverInternal(
    delivery: Gateway.InternalDeliver,
    beforeRun: (admission: Trigger.FireAdmission) => Promise<void>,
  ): Promise<Ingress.IngressResult>;
}
```

`deliver` preserves today's external behavior, including lazy
`Session.materialize`, and still returns `mode: "direct"`.
`deliverInternal` never materializes: it requires the exact existing
`ownerSessionId`, because resurrecting an expired/deleted owner would violate
the durable bridge, and returns `mode: "internal"`.

Both methods enqueue their entire admission-then-run closure on one in-memory
promise tail per session; an empty tail is removed when it drains. Each next
link starts from the prior promise's settled outcome, so one rejected delivery
is reported to its caller but cannot poison later turns. The internal
closure admits, awaits `beforeRun`, and only then invokes the model. The Trigger
host first records the internal route and marks the Fire
`recorded -> delivered`, then calls `deliverInternal` with a callback that
performs the `delivered -> acked` CAS from the admission receipt. If that ack
reserves a replacement Fire, the callback awaits only its global queue
insertion, never its same-session Resident result (which is ordered behind the
current tail). If admission or acknowledgement fails, that closure does not run the model and the delivered
Fire remains the recovery item. An already-`delivered` retry performs the same
idempotent admission; an already-`acked` Fire validates its stored admission
and is not delivered or run again.

Serializing admission as well as execution prevents an immediately-due Trigger
created by a tool from inserting a new user message in the middle of its own
Resident turn. The tool awaits only durable Trigger/source scheduling and
Trigger delivery-queue acceptance, never the nested Resident closure. A
process crash may still lose that closure after Fire ack, which is the
explicitly documented non-resumption window.

For an internal trigger event, the message ID is deterministic:
`trigger-fire:<fireId>`. `Session` gains an idempotent admission helper in
`packages/ledger/src/session/messages.ts`; the local adapter contract in
`packages/ledger/src/storage/storage.ts` and
`sqlite-message-adapter.ts` gain this optional-for-fakes,
required-in-production primitive:

```ts
type AdmitInternalTriggerInput = Readonly<{
  sessionId: string;
  fireId: string;
  payload: string;
  payloadDigest: string;
  admittedAt: number;
}>;

type AdmitInternalTriggerOutcome =
  | Readonly<{ kind: "inserted" | "existing"; receipt: Trigger.FireAdmission }>
  | Readonly<{ kind: "owner_missing" }>
  | Readonly<{ kind: "conflict" }>;

message.admitInternalTrigger?(
  input: AdmitInternalTriggerInput,
): AdmitInternalTriggerOutcome;
```

The Session helper fails `adapter_absent` when the primitive is missing. The
SQLite operation runs one immediate transaction and follows these rules:

- first require that the exact owner session is present and visible at
  `admittedAt` under the existing Session boundary (`admittedAt > expiresAt`
  means expired). Absence raises the typed admission outcome
  `owner_session_missing`. Re-check and schema-parse the raw row inside the
  write transaction so a concurrent expiry sweep/delete becomes the same
  outcome rather than an FK error or a new session;
- if that ID is absent, atomically insert one valid `Message.UserMessage` with
  `id = trigger-fire:<fireId>`, `sessionID = ownerSessionId`,
  `role = "user"`, `time.created = admittedAt`, the model copied from the
  existing session row, `agent = "system"`, and `system = "trigger.fire"`
  (optional tools/variant absent). Insert exactly one `Message.TextPart` with
  `id = trigger-fire-part:<fireId>`, `sessionID = ownerSessionId`,
  `messageID = trigger-fire:<fireId>`, `type = "text"`, and `text` equal to the
  exact rendered Fire payload (optional time/metadata absent). Then set
  `messageCount = (messageCount ?? 0) + 1` and
  `time.updated = max(time.updated, admittedAt)`. Return the receipt only after
  all three projections commit;
- if it is present, query by the global message ID (not only by the requested
  session) and accept it as the same receipt only when its session, marker,
  single text part, exact payload text, and `canonicalDigest(payload)` all
  match the request. The digest is recomputed from the immutable admitted text;
  no unowned digest column or second receipt table is introduced. A matching
  retry returns without incrementing `messageCount` or publishing a second
  content update. The first insert publishes exactly one `Session.Event.Updated`
  after commit, rather than the two publishes produced by separate
  `addMessage`/`addPart` calls;
- if it is present for another session, has another role/part shape, or has a
  different payload/digest, fail closed with a typed admission error. A
  partial or mismatched message-part pair, including an independently colliding
  deterministic part ID, is a conflict, never a silent repair.

This helper is a brain/session write and does not update the trigger row in the
same transaction. It does not call `Session.materialize`; external deliveries
continue to do that in their compatibility path. The durable bridge is the
stable fire ID, so the unavoidable crash window between session admission and
fire acknowledgement converges on a safe retry without violating the gateway's
domain-isolation rule. If the session disappears in that window, the existing
deterministic message either proves admission or the Fire remains unacked and
a non-ended Trigger pauses `owner_session_missing` (an already-ended parent
retains its terminal state); no replacement session is minted.

The trigger payload is framed as a system notification containing the
Resident-authored prompt and explicitly labeled source observations. It is a
normal Resident turn, not an evidence-only turn: the internal producer is
trusted system code, while command/file bytes remain quoted data inside the
payload. The ordinary Resident policy and tool catalog still apply. A source
line cannot grant authority, alter routing, or become a tool call by text.

The `beforeRun` callback acknowledges after internal admission commits, not
after the LLM completes. A model/provider failure is therefore handled by the
existing Resident failure
path and does not cause a fire replay storm. The admission message is durable
and the fire is acknowledged exactly once; model execution itself is not
claimed to be exactly-once.

## 8. App host, boot, and shutdown wiring

### 8.1 Construction and effect ownership

Add the public `TriggerHost` in `apps/openomni/src/trigger/index.ts` with these
injected ports:

```text
clock: TriggerClock
ids: triggerId/fireId/traceId factories
triggers: TriggerStore + TriggerFireStore
sessions: existing-owner lookup used by recovery reconciliation
resident: internal Resident delivery consumer
internalRoute: internal route recorder/delivery facade
notifier: pure Trigger.Notifier fold adapter
sources: command/file factories
```

The host owns no product state that belongs in a row. It keeps only timer and
source handles, in-flight promises, retry handles, and the ephemeral notifier
state. Every durable mutation goes through the ledger stores.

Wire the host in `apps/openomni/src/index.ts` after storage, Resident, and the
internal delivery facade exist, and before external channel startup. The tool
cycle uses the app's existing late-binding convention: create one
`TriggerToolPort` proxy whose methods call a `requiredTriggerHost()` getter,
pass that proxy into `createResident`, then construct and assign `triggerHost`
after `gateway = createResidentGateway(...)`. No tool can run before external
startup, and the getter fails loudly if composition regresses.

Use the existing composer so `stop()` is a reverse-order effect. Relative to
the current boot sequence, run `WaitService.sweepExpired` and
`Session.sweepExpired`, start the delegation kernel, arm its wake queue, and
then mount recovery exactly as:

```ts
await composer.mount("trigger.host", async (ctx) => {
  // Register cleanup before recovery so partial startup rolls back.
  ctx.effect(() => triggerHost.stop());
  await triggerHost.startRecovery();
});

await composer.mount("channels", /* existing external reconcile */);
```

This places trigger delivery behind a live Resident consumer while keeping
external channels closed during replay. The stage does this behind one closed
recovery gate:

1. read indexed active/unacked candidate IDs, then parse each row separately;
2. reconcile parent gates, Fire ownership, active-cap conflicts, and owner
   sessions without acting;
3. install the delivery queue without starting its drain, and enqueue valid
   unacked Fires;
4. fold absolute expiry/timeout recovery for every non-ended row, using
   `trigger.restored` when no more specific parent fact is produced;
5. re-arm eligible schedules and activate eligible sources only after older
   Fire replay is queued;
6. open the drain and accept new tool/source events only after every recovery
   mutation and queue insertion has completed.

The host's global delivery queue is deterministic by `(recordedAt, fireId)`;
per-trigger serialization is the Fire gate. A second owner-session mutation
queue serializes all mutating tools, notifier flushes, and wake-budget batches
so the at-most-six-row transaction is built from one coherent owner snapshot.
Unacked replay is queued before a new source can reserve another Fire for that
trigger.

Normal external/user admission calls `notifier.noteActivity` once after it is
identified as non-trigger activity; individual catalog tool calls do not reset
it again. An internal `meta.kind = trigger.fire`
delivery never resets the monitor wake streak. This hook belongs in the app
composition/Resident seam, not in the channels router.

### 8.2 Boot matrix

Every parsed non-ended row accepts one `restore` input before a runtime handle
is installed. Unless that input produces a more specific reserve, coalesce,
pause, or end fact, it appends `trigger.restored` and advances the logical-clock
watermark without changing lifecycle.

| Persisted condition | Boot action | Result |
| --- | --- | --- |
| `armed` `time.once`, due in future | append `trigger.restored`; arm one timer at `at` | logical watermark advances; one late-or-on-time fire, then `completed` |
| `armed` `time.once`, due now/past | reserve one `recovery` fire immediately | exactly one fire, then `completed` |
| `paused` `time.once` | install no timer, even when due | explicit rearm retains the original due instant and then fires once |
| `armed` `time.every`, future legal `nextFireAt` | append `trigger.restored`; arm one timer | lifecycle is unchanged until due |
| `armed` `time.every`, due but before expiry | reserve one `recovery` fire; set next to `now + interval` | missed periods collapse to one |
| non-ended `time.every`, at/after expiry or with no legal next fire before expiry | end `expired`; do not fire | no fire at the inclusive boundary |
| `paused` `time.every` before expiry | install no schedule timer | explicit rearm recomputes from then-current logical time |
| non-ended finite command/file, at/after `expiresAt` | reserve/coalesce one timeout summary and end `source_timeout`; open no handle | absolute lifetime is not extended by downtime or pause |
| `paused` finite command/file before expiry | open no source; arm only the remaining absolute timeout | explicit rearm is required; timeout can still end it |
| `paused` persistent command | open no source or timer | explicit rearm starts a new child; no old PID is sought |
| `ended` any kind | do not rearm | terminal state is never resurrected |
| `armed` command before expiry (or persistent) | spawn a fresh command source after replay is queued | old PID is not searched for or resumed |
| `armed` file before expiry | repeat full safety activation | a safe present `on:create` target completes immediately; transient failure pauses `source_unavailable`; unsafe identity ends `source_error` |
| unacked `recorded` fire | claim/re-push the stable fire ID | no new fire row |
| unacked `delivered` fire | re-push until the admission receipt is found | ack follows admission |
| acked fire | no delivery | retained as history |
| parent has one valid unacked fire plus pending bit | replay the fire first; drain one pending fire after ack | one in-flight at all times |
| parent has multiple unacked fires | do not guess an order or deliver concurrently | pause a non-ended parent `recovery_conflict`; preserve an ended parent; report operational error |
| `inFlightFireId` points to missing/corrupt fire | do not synthesize a fire | pause a non-ended parent `recovery_conflict`; preserve an ended parent; report operational error |
| owner session missing | do not route to a new session | leave Fire unacked; pause a non-ended parent `owner_session_missing`, but preserve an ended parent |
| more than five non-ended rows due to preexisting corruption | preserve rows already paused; apply normal lifecycle rules to the deterministic first five (`createdAt,id`), and pause any later armed row as `recovery_conflict` | report extras; every non-ended row still consumes capacity, so no cap bypass |
| corrupt trigger/fire JSON | do not reset or delete it | affected row is not armed/delivered; operational error |
| graceful shutdown | cancel handles, preserve `armed`/`paused` rows and unacked fires | next boot follows this same matrix |

The boot sweep is deliberately after Resident and the internal Gateway delivery
consumer are constructed, just as current delegation recovery waits for its
Resident delivery. If a recovery delivery fails, the row remains unacked and
is retried with bounded backoff; boot continues for unrelated triggers. OS
process resurrection is out of scope: launchd/systemd may resurrect the sole
OpenOmni app, but this subsystem never discovers or reattaches a pre-crash PID.
A detached child outside the supervisor's kill domain may therefore remain an
untracked orphan as described in §5.1; recovery never guesses that PID.

### 8.3 Shutdown and failure isolation

`TriggerHost.stop()` first latches every source as host-shutdown cleanup, then
stops accepting observations, cancels deadline, notifier, delivery-retry, and
kill-grace timers, disposes file watches, and terminates live command process groups with
the same bounded grace sequence as cancellation. The latch makes the resulting
child exit callback cleanup-only, so shutdown cannot race itself into a
`source_exited` summary. It waits for every already-accepted
`deliverInternal` promise, including its Resident model phase, to settle before
allowing storage teardown; an accepted session-tail closure is never orphaned
against a closed ledger. It does not turn an armed trigger into `paused`
merely because the process is shutting down; shutdown cleanup is not a
`trigger_cancel` and emits no terminal summary or lifecycle fact. A crash and a
graceful stop therefore have the same durable recovery semantics.

A malformed row, unavailable source, or one failed delivery is isolated to its
trigger. The host publishes an existing operational error and continues the
boot/recovery sweep. It never catches a store error and pretends that the
trigger was reset.

## 9. Resident tool surface

### 9.1 Four tools, one family

Add `apps/openomni/src/tools/triggers.ts`. All four specs are factories named
and exported so `lint:tools` can verify that the catalog wires them:

| Tool | Input | Safe | Effect |
| --- | --- | --- | --- |
| `trigger_create` | `{ prompt, source }` | false | create and arm one trigger |
| `trigger_list` | `{ include_ended? }` | true | list only the current Resident session's triggers |
| `trigger_cancel` | `{ trigger_id }` | false | end future source work; retain existing fires |
| `trigger_rearm` | `{ trigger_id }` | false | resume one paused trigger and reset its notifier suppression |

Machine result shapes are fixed. `lifecycle` is the following snake-case tool
projection, not an untyped display string:

```ts
type TriggerToolLifecycle =
  | { state: "armed" }
  | { state: "paused"; reason: Trigger.PauseReason; at: number }
  | { state: "ended"; reason: Trigger.EndReason; at: number; detail?: string };
```

```text
trigger_create -> {
  trigger_id, kind, lifecycle: TriggerToolLifecycle,
  next_fire_at?, expires_at?
}
trigger_list   -> {
  triggers: [{
    trigger_id, kind, lifecycle: TriggerToolLifecycle,
    next_fire_at?, expires_at?, fire_count,
    last_observed_at, last_fired_at?
  }]
}
trigger_cancel -> { trigger_id, lifecycle: TriggerToolLifecycle }
trigger_rearm  -> {
  trigger_id, lifecycle: TriggerToolLifecycle, next_fire_at?, expires_at?
}
```

Every mutating tool awaits its post-commit host effect (source/timer activation
or Fire reservation and queue acceptance, never Resident model completion) and
then returns the latest durable lifecycle. Creation itself always commits revision one as
`armed`, but its truthful receipt may already be `paused(source_unavailable)`
or terminal when activation/immediate due handling won before the readback.
Likewise rearm can report an activation pause, and cancelling an already-ended
trigger returns its original terminal reason rather than falsely rewriting it
to `cancelled`. Lifecycle `detail`, when present, is capped at
`MAX_DETAIL_CHARS` and never contains raw output. Tool errors carry the Trigger
error `code` and never rely
on prose matching. Once creation committed, activation failure returns the
trigger receipt rather than a no-ID error.

There is intentionally no model-facing `trigger_pause`: wake-budget and source
safety pauses are kernel actions, not a way for a model to evade the active
cap. `trigger_cancel` is idempotent on an already-ended row; `trigger_rearm` on
an ended row returns `invalid_transition` and never resurrects it. There is no
edit or delete tool because Fire history and replay identity must remain stable.

### 9.2 Create schema

The executable Zod gate is strict and has one branch-refinement owner:

```ts
const TriggerCreateToolSourceInput = z.object({
  kind: z.enum(["time.once", "time.every", "event.command", "event.file"]),
  at: EpochMs.optional(),
  interval_ms: PositiveSafeInt.optional(),
  command: z.string().min(1).max(MAX_COMMAND_CHARS).optional(),
  filter: z.string().max(MAX_FILTER_CHARS).optional(),
  persistent: z.boolean().optional(),
  path: z.string().min(1).max(MAX_PATH_CHARS).optional(),
  on: z.enum(["create", "modify"]).optional(),
}).strict().superRefine((source, ctx) => {
  // Require exactly the selected branch's fields and reject every other branch
  // field. The executor applies the documented defaults after parsing and
  // compiles filter before storage. The table below is exhaustive.
});

const TriggerCreateToolInput = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
  source: TriggerCreateToolSourceInput,
}).strict();
```

The hand-written public JSON schema mirrors those fields but deliberately has
no root `oneOf`:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["prompt", "source"],
  "properties": {
    "prompt": { "type": "string", "minLength": 1, "maxLength": 16384 },
    "source": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind"],
      "properties": {
        "kind": {
          "type": "string",
          "enum": ["time.once", "time.every", "event.command", "event.file"]
        },
        "at": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "interval_ms": { "type": "integer", "minimum": 1, "maximum": 9007199254740991 },
        "command": { "type": "string", "minLength": 1, "maxLength": 8192 },
        "filter": { "type": "string", "maxLength": 1024 },
        "persistent": { "type": "boolean" },
        "path": { "type": "string", "minLength": 1, "maxLength": 4096 },
        "on": { "type": "string", "enum": ["create", "modify"] }
      }
    }
  }
}
```

The other three runtime gates and their hand-written JSON schemas are exact,
strict objects as well:

```ts
const TriggerListInput = z.object({
  include_ended: z.boolean().default(false),
}).strict();

const TriggerIdInput = z.object({
  trigger_id: z.string().min(1),
}).strict(); // shared by cancel and rearm
```

```json
{
  "trigger_list": {
    "type": "object",
    "additionalProperties": false,
    "properties": { "include_ended": { "type": "boolean", "default": false } }
  },
  "trigger_cancel": {
    "type": "object",
    "additionalProperties": false,
    "required": ["trigger_id"],
    "properties": { "trigger_id": { "type": "string", "minLength": 1 } }
  },
  "trigger_rearm": {
    "type": "object",
    "additionalProperties": false,
    "required": ["trigger_id"],
    "properties": { "trigger_id": { "type": "string", "minLength": 1 } }
  }
}
```

At the nested source boundary the executable refinement requires exactly the
fields for the selected kind and rejects all other branch fields:

| `source.kind` | Required | Defaults/normalization |
| --- | --- | --- |
| `time.once` | `at` | none; no expiry |
| `time.every` | `interval_ms` | clamp to at least 60,000 ms; reject an interval with no possible fire before expiry |
| `event.command` | `command` | `persistent=false`; compile optional regex before store |
| `event.file` | `path` | `on="create"` if omitted; resolve path in app cwd |

A `time.once` whose `at <= now` is committed as `armed` and immediately enters
one scheduler step after the transaction; the response may therefore observe
`ended(completed)` on its next read, but it can never create two Fires.

`source` is one nested public field, so the tool remains below the repository's
five top-level-field limit and remains compatible with providers that flatten
root unions poorly. The nested branch semantics are tested at the executable Zod
gate and in the schema snapshot; they are not inferred from model prose.

`trigger_list` never returns another session's rows. It first selects non-ended
rows in oldest `(createdAt,id)` order (normally at most five; recovery-conflict
corruption remains visible). By default that is the whole result. With
`include_ended: true`, it fills the remaining slots up to
`MAX_TRIGGER_LIST_ROWS` with the owner's newest ended rows, then sorts the
selected union into oldest `(createdAt,id)` result order. Thus ended history
cannot displace a valid active row; if corruption alone supplies more than 100
non-ended rows, the deterministic first 100 are returned and the boot sweep has
already reported the conflict. Its result includes IDs, kind, lifecycle,
next/expiry times, fire count, and last observation/fire times; lifecycle
carries the pause reason or terminal reason/detail. It omits raw command text,
regex, and source output from the normal list response. `trigger_cancel` and
`trigger_rearm` resolve the ID in
the origin session and return `not_found` for any other owner.

### 9.3 Role and catalog gate

Add `triggers?: TriggerToolPort` to `CatalogPorts` and add exactly four rows to
`CATALOG_TOOLS`. The port is session-agnostic; catalog executors bind the owner
argument from `origin.sessionId`:

```ts
interface TriggerToolPort {
  create(ownerSessionId: string, input: unknown): Promise<Trigger.Record>;
  list(ownerSessionId: string, includeEnded: boolean): Promise<Trigger.Record[]>;
  cancel(ownerSessionId: string, triggerId: string): Promise<Trigger.Record>;
  rearm(ownerSessionId: string, triggerId: string): Promise<Trigger.Record>;
}

ports.triggers !== undefined && origin.role === "resident"
```

The catalog gate is the one role enforcement layer. `apps/openomni/src/index.ts`
wires one session-agnostic `TriggerToolPort` backed by `TriggerHost`; each
`CATALOG_TOOLS` row binds `origin.sessionId` when `catalogEntries` builds that
turn's executor, exactly like the artifact write precedent. No executor accepts
an owner session ID from tool input. A Worker therefore does not receive these
tools at all, rather than receiving a tool that always refuses. Unit tests
exercise this catalog gate rather than a second copied role check.

After implementation, run `bun run lint:tools --update` only with the schema
review and commit the derived
`script/conformance/schema-snapshot.json`. The implementation must first add
`Trigger` to the Tier-2 vocabulary line in `docs/core-model.md`; otherwise the
existing namespace ratchet correctly reports a new unmapped protocol namespace.

## 10. Delivery and acknowledgement sequence

```text
Resident tool / timer / source
        |
        v
pure Trigger scheduler + notifier fold
        |
        |  persist first: trigger reservation + Fire row + paired facts (FULL txn)
        v
Trigger.Fire { id, status: recorded, immutable payload }
        |
        |  persist delivery-attempt receipt; build stable internal route
        v
internal Gateway.InternalDeliver (mode=internal, sessionId=ownerSessionId)
        |
        |  append internal route.decided before execution
        v
fire CAS: recorded -> delivered
        |
        |  enqueue Resident.deliverInternal on the session turn tail
        v
internal admission phase
        |
        |  require the existing owner session; idempotent message/part
        |  admission commits with message id trigger-fire:<fireId>
        v
beforeRun(admission)
        |
        |  fire + parent CAS: delivered -> acked + release
        |  (and fingerprint-pinned pending reservation, when present)
        v
normal Resident model phase
        model failure is separate
```

Crash windows are intentional and closed by identity:

- before the fire transaction commits: there is no promise and no action;
- after `recorded` and before route/`delivered`: boot re-pushes the same fire;
- after `delivered` and before session admission or `acked`: retry finds the
  deterministic message (or admits it) and returns its existing admission;
- after `acked` and before model completion: the session message is durable and
  the fire is not replayed. This slice does not claim automatic model-turn
  resumption; an interrupted admitted turn remains visible in session history
  and later Resident activity can continue from it.

A duplicate route delivery uses the existing route equivalence gate. A duplicate
Resident admission uses the deterministic message ID and payload digest. A
duplicate ack reads the already-acked row. These three gates are independent;
none relies on a best-effort Bus event.

## 11. Failure, dedupe, and clamp matrix

| Fault or boundary | Durable fact/state | Required behavior |
| --- | --- | --- |
| process dies after tool validation, before create commit | no trigger row | no source starts and no fire exists |
| process dies after create commit, before source activation | armed trigger row, no handle | boot repeats activation from configuration; no world event was promised |
| source activation fails after create commit, before a handle exists | trigger row | close partial resources, pause `source_unavailable`, and return the durable ID/state rather than inviting duplicate create |
| source activation fails after a handle exists | trigger row plus terminal transition | reserve/coalesce one safety summary, end `source_error`, and clean up the handle |
| storage busy during create/transition/ack | no committed unit | typed `unavailable`; caller does not act or invent a retry result |
| duplicate trigger ID | existing row | typed `duplicate`; no second `trigger.created` |
| Fire ID already exists during reservation | existing child/parent receipt or collision | exact trigger+digest+gate is an idempotent retry; any divergent collision rolls the transaction back and returns `duplicate` without acting |
| stale app-built Fire material | newer parent revision/fingerprint | typed `revision_conflict`; reread and rebuild, never let ledger reuse stale rendering |
| timer callback runs twice | generation token plus parent CAS/in-flight ID | stale generation is ignored; a genuinely later due occurrence coalesces behind the one Fire |
| source line arrives while fire is in flight | `coalescedFirePending` plus bounded batch | no second in-flight fire; one pending fire after ack |
| many recurring periods missed during sleep | current `nextFireAt` and logical now | one catch-up fire, next = now + interval |
| once alarm is already past due | source `at`, no expiry | one late fire, then `completed` |
| recurring callback at expiry | `Deadline.isExpired` | end `expired`; never fire at `now >= expiresAt` |
| requested recurring interval below 60 s | requested/effective fields | effective interval is exactly 60,000 ms; no rapid loop |
| requested interval cannot fire before seven-day lifetime | create input | typed refusal; no inert recurring row |
| timer delay above 24.8 days | no special row state | max-delay re-arm chain rechecks clock; no clamp, overflow, or early fire |
| derived deadline would exceed `MAX_COUNTER` | create input or checked recurrence subtraction | reject create, or use the safe expiry sentinel and end; never schedule from an imprecise sum |
| wall clock moves backward | durably restored `lastObservedAt` | logical time does not move backward; no early fire |
| wall clock jumps forward | current row | normal lateness/expiry rules apply; missed recurrence does not fan out |
| command regex is invalid | no trigger row | typed source refusal; no child process |
| command contains NUL | no trigger row | typed `command_invalid`; never pass an invalid argv string to `spawn` |
| UTF-8 code point spans stdout chunks | volatile `StringDecoder` state | emit the original decoded character once; never fingerprint replacement-byte corruption |
| child exposes a second data pipe despite in-shell `exec 2>&1` | owned process/pipe | drain bytes, end `source_error` with detail `source_pipe`, and never race two line streams |
| command emits a partial final line | line buffer is volatile | discard partial line; still emit exit summary |
| command exits nonzero | source terminal observation | summary always passes notifier suppression; end `source_exited` |
| command times out | source deadline | terminate, emit summary, end `source_timeout` |
| command child dies with unread output | source handle closes | emit every line already framed before close; discard only the unfinished partial line; summary is still emitted |
| host restarts during persistent command | no child handle persisted | start a fresh child only if trigger remains armed; never guess or reattach a PID |
| hard crash leaves a detached command outside the supervisor kill domain | no safe durable process identity | treat it as an untracked orphan and report the operational risk; recovery starts from configuration and never signals a guessed PID |
| initial `on:create` target already exists | no trigger row | typed `source_identity`; an existing durable trigger may instead accept safe presence during activation/recovery/rearm |
| file target is a symlink at registration | no trigger/source | typed refusal; never open/follow it |
| file parent realpath changes | source terminal fact | end `source_error`; do not follow the new parent |
| file target is replaced (device/inode differs) | source terminal fact | end `source_error`; do not silently adopt replacement |
| file changes during digest | identity recheck fails | no line fire; terminal safety summary/error |
| duplicate `fs.watch` callbacks | dirty bit | at most one follow-up check; no duplicate change fire |
| notifier queue exceeds 50 lines/character budget | per-trigger overflow count | omit excess, disclose count in next eligible fire |
| line batch repeats previous fingerprint | last fingerprint | suppress without fire/wake; rearm clears fingerprint |
| line batch is rate-limited | pending queue | retain until earliest allowed time; no busy loop |
| terminal summary is rate-limited or duplicate | terminal item | bypass rate/fingerprint and deliver; reset wake streak |
| fifth consecutive intermediate wake | one batched Fire/pause transaction | durably pause every armed owner event trigger before delivering the fifth notice; preserve other pause reasons; require explicit rearm |
| line arrives during wake pause | no queued line | discard intermediate line; terminal summary still passes |
| trigger cancel with unacked fire | trigger ended, Fire unacked | finish/retry the existing Fire; event sources then drain one cancellation summary, while time-source pending markers are discarded |
| paused finite source reaches its deadline | absolute `expiresAt` and retained timeout | terminal timeout summary bypasses pause; end `source_timeout` |
| graceful shutdown kills a child | shutdown latch, armed row | child exit is cleanup-only; no terminal fact/summary; next boot starts a new child |
| boot sees one unacked fire | fire status recorded/delivered | replay stable ID before new source fire |
| boot sees two unacked fires for one trigger | inconsistent projection | pause `recovery_conflict`; never deliver concurrently or guess |
| trigger row is malformed | no trusted state | fail closed for that row; operational error; no reset |
| fire row is malformed | no trusted delivery | fail closed for that fire; operational error; no new substitute fire |
| owner session was removed/expired | Fire remains unacked | pause a non-ended parent `owner_session_missing`; preserve an ended parent; never route to a replacement session |
| delivery fails after attempt claim | same Fire status | bounded retry/backoff; no `failed` fiction and no replacement ID |
| stable route ID has a non-equivalent prior decision | route conflict plus unacked Fire | stop retrying in-process, pause a non-ended parent `recovery_conflict`, and report; never execute the conflicting route |
| deterministic admission ID has different content/owner | admission conflict plus unacked Fire | stop retrying in-process, pause a non-ended parent `recovery_conflict`, and never overwrite the message |
| owner session disappears between route and admission | no matching deterministic message | admission returns `owner_session_missing`; Fire remains unacked, non-ended parent pauses, and no session is materialized |
| crash after session admission, before fire ack | deterministic message exists | retry is an idempotent admission, then ack |
| crash after fire ack, before LLM completion | acked fire and user message | no duplicate wake; interrupted model execution is visible but not automatically resumed in this slice |
| ack races with another ack | fire/parent CAS | one winner; matching loser reads existing ack and emits no duplicate effect |
| pending batch changes while ack material is built | advanced parent revision/fingerprint | ack writes nothing; host rebuilds the replacement reservation from the fresh batch |
| notifier restarts with empty suppression state | recorded Fires and post-gate pending batches remain durable; pre-flush queue does not | a fresh command may repeat a bounded source batch with a new Fire ID, while replay of an existing Fire ID/session admission dedupes |
| active cap race between two creates | serialized store transaction | only five non-ended rows for an owner; loser gets `active_cap` |
| paused rows counted at create | lifecycle `paused` | pause cannot be used to evade the cap |

The guarantees are intentionally scoped: each durable Fire reservation is
single-winner by CAS, an unacked Fire is delivered at least once, and Resident
message admission is exactly-once by deterministic identity. An observation
still inside the two-second notifier queue and model execution after admission
have no exactly-once guarantee across a process crash. An unknown durable
outcome is never converted into "did not happen."

## 12. Layered test plan

All async tests subscribe to the exact completion signal or use injected fake
ports. No fixed sleeps, polling delays, or wall-clock waits are used to make a
test pass.

### 12.1 Protocol tests

Create `packages/protocol/test/trigger/`:

- `schema.test.ts`: every source branch, strict unknown-field rejection,
  interval normalization shape, lifecycle terminal-field discrimination,
  required creation-time `lastObservedAt`, bounded terminal detail,
  canonical-digest shape and mismatch refusal, once-without-expiry, recurring
  expiry and safe-integer arithmetic, pending-batch/rendered-character bounds,
  Fire payload arithmetic, status timestamp requirements, event revision
  fields, and typed store-error parsing;
- `scheduler.test.ts`: one timer effect, early callback, due callback,
  recurring catch-up, in-flight coalescing, fingerprint-pinned ack drain,
  paused time scheduling versus retained finite-source timeout, rearm
  semantics, inclusive expiry, late once exactly once, terminal source
  handling, no-other-change `trigger.restored` behavior, clock rollback, and
  immutability of input state;
- `notifier.test.ts`: first-event coalescing, exact rate boundary, queue line and
  character overflow, per-trigger fingerprint, summary bypass, wake budget at
  five, activity reset, explicit rearm reset, quiet-gap reset, and terminal
  deferred-line discard.

Use a table-driven transition suite and invariant/property cases over generated
finite sequences. Assert machine outputs and fields, not notification prose.

### 12.2 Ledger tests

Create `packages/ledger/test/trigger/` and the Map helper:

- run the same store contract against Map and SQLite adapters;
- prove create/reserve/status/ack facts and projection revisions agree;
- inject projection/CAS failure and assert the appended fact rolls back;
- race stale revisions and duplicate IDs; assert typed errors and no Bus side
  effect before commit; inject one stale member into a wake-budget
  `transitionBatch` and prove every Fire/pause write rolls back;
- prove `listUnackedIds` ordering, per-ID corrupt-row isolation,
  pending-drain atomicity, stale-fingerprint refusal, and ack idempotency;
- reopen a file-backed database and recover all trigger/fire rows;
- apply migrations to a legacy database containing `cron_job`, prove the new
  tables exist and no legacy row is converted;
- assert malformed JSON fails closed and `clear()` deletes fire rows before
  trigger rows;
- assert production completeness rejects an adapter missing either capability
  or `message.admitInternalTrigger`;
- directly test internal admission's deterministic message/part IDs, copied
  session model, monotonic session timestamp/count, expiry boundary, exact
  retry, global-ID collision, partial-row conflict, and one post-commit event.

### 12.3 App/source tests

Create `apps/openomni/test/trigger/`:

- fake clock/timer tests prove one handle per trigger, max-delay chaining,
  stale-callback rejection, finite-source timeout while paused, boot ordering,
  post-commit activation recovery, and graceful-stop exit latching;
- command source tests use a fake child stream to prove merged chunks,
  split-code-point UTF-8 decoding, CRLF framing, partial-line discard, NUL
  refusal, regex filtering, exit summary on every exit, timeout, cancellation,
  and output discard while paused;
- file source tests use an injected filesystem port to exercise initial
  `on:create` presence refusal, absent/create, recovery/rearm presence, and
  modify digest, symlink rejection, parent pin, target realpath, device/inode
  replacement, post-read race, dirty recheck, and timeout without sleeping;
- notifier-host tests prove emitted folds become durable fires and that a
  source summary cannot be suppressed;
- delivery tests inject crashes at record, route, admission, delivered, and
  ack boundaries; assert stable Fire/message/part IDs, one session message,
  missing-owner non-materialization, pending-fingerprint retry, and boot replay;
  hold one Resident run on an explicit deferred gate and prove a same-session
  Trigger run starts only after that gate resolves (no sleeps);
- boot tests cover every row of the boot matrix, including restore watermark
  facts, the closed recovery/drain gate, corrupt/multiple-unacked conflict, and
  missing owner session;
- `tools/triggers.test.ts` proves branch validation, owner scoping, role
  omission for Workers, and exact machine result fields;
- catalog/schema tests assert all four specs appear through `collectToolSpecs`,
  all four are wired in `CATALOG_TOOLS`, and `lintToolSurface` sees no field
  count/name/description violation.

### 12.4 Repository and integration checks

The implementation slice must run:

```text
bun run check-types
bun run build
bun run lint
bun run lint:tools
bun run script/check-topology.ts
bun run script/check-deps.ts
bun run script/check-import-cycles.ts
bun run script/check-dead-exports.ts
bun run script/verify-tsconfig-inheritance.ts
bun run script/verify-ledger-rename.ts
bun run script/check-ledger-schema-drift.ts
bun test --timeout 15000
```

The app integration exercise uses a fake LLM and exact admission promises to
create a once trigger, advance the fake clock, observe the internal
`Gateway.InternalDeliver` through the `Gateway.Deliver` union, restart the host
against the same SQLite file, and verify
that an unacked fire is admitted once. It does not use a real-time sleep.

## 13. Exact implementation file plan

The following is the complete intended file inventory for implementation. No
file in the list is part of this documentation-only commit.

### 13.1 New files

| Path | Responsibility |
| --- | --- |
| `packages/protocol/src/trigger/schema.ts` | source, lifecycle, record, fire, input, constants, typed store errors |
| `packages/protocol/src/trigger/events.ts` | Trigger Bus descriptors |
| `packages/protocol/src/trigger/scheduler.ts` | pure scheduler transition fold and effect types |
| `packages/protocol/src/trigger/notifier.ts` | pure coalescing/rate/fingerprint/budget fold |
| `packages/protocol/src/trigger/index.ts` | public `Trigger` namespace facade and canonical-digest re-export |
| `packages/protocol/test/trigger/schema.test.ts` | schema/refinement coverage |
| `packages/protocol/test/trigger/scheduler.test.ts` | scheduler transition/invariant coverage |
| `packages/protocol/test/trigger/notifier.test.ts` | notifier fold coverage |
| `packages/ledger/src/trigger/index.ts` | `TriggerStore` and `TriggerFireStore` high-level writes/reads |
| `packages/ledger/src/storage/sqlite-trigger-adapter.ts` | trigger projection adapter |
| `packages/ledger/src/storage/sqlite-trigger-fire-adapter.ts` | fire projection adapter |
| `packages/ledger/migration/0030_trigger_subsystem/migration.sql` | forward SQLite schema |
| `packages/ledger/test/helpers/trigger.ts` | parsed Trigger/Fire fixture builders |
| `packages/ledger/test/trigger/memory-trigger-adapters.ts` | Map-backed trigger/fire adapters for contract parity |
| `packages/ledger/test/trigger/store.test.ts` | store/fact/CAS contract |
| `packages/ledger/test/trigger/persistence.test.ts` | SQLite/migration/reopen parity |
| `packages/ledger/test/trigger/admission.test.ts` | deterministic existing-session admission and collision contract |
| `apps/openomni/src/trigger/index.ts` | public TriggerHost composition facade |
| `apps/openomni/src/trigger/scheduler.ts` | injected timer/clock host and durable scheduler calls |
| `apps/openomni/src/trigger/notifier.ts` | notifier fold host and bounded rendering |
| `apps/openomni/src/trigger/delivery.ts` | internal route decision and Resident delivery/ack bridge |
| `apps/openomni/src/trigger/boot.ts` | recovery matrix and unacked replay |
| `apps/openomni/src/trigger/sources/command.ts` | child process and line source |
| `apps/openomni/src/trigger/sources/file.ts` | safe parent-pinned file source |
| `apps/openomni/src/tools/triggers.ts` | four Resident-only tool specs/executors |
| `apps/openomni/test/trigger/scheduler.test.ts` | app timer/boot host tests |
| `apps/openomni/test/trigger/sources-command.test.ts` | command source tests |
| `apps/openomni/test/trigger/sources-file.test.ts` | file safety/source tests |
| `apps/openomni/test/trigger/notifier.test.ts` | app notifier integration tests |
| `apps/openomni/test/trigger/delivery.test.ts` | crash/dedupe/admission tests |
| `apps/openomni/test/trigger/boot.test.ts` | boot/shutdown matrix tests |
| `apps/openomni/test/tools/triggers.test.ts` | tool role/schema/ownership tests |

### 13.2 Existing files to modify

| Path | Change |
| --- | --- |
| `packages/protocol/src/index.ts` | export the Trigger facade |
| `packages/protocol/src/storage/index.ts` | add trigger/fire adapter interfaces, filters, candidate-ID scans, and indexed active count |
| `packages/protocol/src/ingress/index.ts` | type internal trigger fire ID and internal event metadata |
| `packages/protocol/src/gateway/schema.ts` | add/narrow internal versus external `Gateway.Deliver` variants |
| `packages/protocol/src/ledger/streams.ts` | register trigger/fire streams and fact types |
| `packages/protocol/test/gateway.test.ts` | parse/refuse exact external/internal delivery variants |
| `packages/protocol/test/ingress-internal.test.ts` | pin typed Trigger activation/meta fields |
| `packages/ledger/src/storage/storage.ts` | add optional/required trigger capabilities and the internal admission primitive type |
| `packages/ledger/src/storage/sqlite-storage.ts` | construct the two SQLite adapters |
| `packages/ledger/src/storage/sqlite-schema-lifecycle.ts` | register migration and clear order |
| `packages/ledger/src/index.ts` | export trigger stores |
| `packages/ledger/src/session/messages.ts` | idempotent, existing-session-only trigger-message admission helper |
| `packages/ledger/src/session/index.ts` | export the admission helper through `Session` |
| `packages/ledger/src/storage/sqlite-message-adapter.ts` | implement transactional global-ID lookup plus message/part/session insert and digest check |
| `packages/channels/src/router/index.ts` | keep external ingest explicitly direct-only; type its injected delivery callback and builder as `Gateway.ExternalDeliver`, never the internal arm |
| `packages/channels/test/router/deliver-contract.test.ts` | retain direct-only router delivery assertions after narrowing |
| `apps/openomni/src/index.ts` | construct/mount TriggerHost, wire recovery, activity, and shutdown |
| `apps/openomni/src/resident.ts` | split admission from execution, serialize same-session runs, and require Trigger identity plus an existing owner session on the internal arm |
| `apps/openomni/src/gateway.ts` | expose the app's internal delivery callback/route facade without changing the external perimeter |
| `apps/openomni/src/tools/catalog.ts` | add `CatalogPorts.triggers` and four `CATALOG_TOOLS` rows |
| `apps/openomni/test/gateway-contracts.test.ts` | cover internal delivery and missing-session refusal through the real app seam |
| `docs/core-model.md` | add `Trigger` to the Tier-2 vocabulary before adding the protocol namespace |
| `docs/implementation-status.md` | move the row from designed to implemented only after the vertical slice ships |
| `AGENTS.md` | refresh verification stamp; dependency graph remains unchanged |
| `packages/protocol/AGENTS.md` | list the Trigger schema/fold domain |
| `packages/ledger/AGENTS.md` | list Trigger stores/adapters and migration ownership |
| `script/conformance/schema-snapshot.json` | generated additive snapshot after protocol implementation review |

The implementation must use public package barrels at package boundaries. No
new app file may import a sibling package's `src` path, and no source adapter
may import the ledger master `Storage` object when a named store port is
available.

## 14. Acceptance checklist and risks

The design is complete when an implementation review can answer yes to all of
the following without consulting the deleted seed:

- all four locked source kinds and only those kinds parse;
- lifecycle and fire status are separate and their transition tables are
  enforced;
- every fire is persisted before delivery and ack follows session admission;
- boot re-arms armed rows, re-pushes unacked rows, and never resurrects a child;
- timer, coalescing, catch-up, late-once, cap, minimum interval, lifetime, and
  24.8-day chain rules are covered by pure tests;
- notifier rate/fingerprint/budget/terminal/overflow behavior is bounded and
  deterministic;
- command and file sources satisfy the listed line and identity safety rules;
- Map and SQLite adapters have the same receipts and failure semantics;
- migration 0030 is forward-only and does not revive `cron_job`;
- internal trigger delivery uses the typed internal mode without opening the
  external channel perimeter;
- the four tools are Resident-only, owner-scoped, catalog-registered, and linted;
- the exact file inventory is implemented without a second orchestration or wire
  surface.

Primary risks are deliberate and visible:

1. **Cross-domain crash window:** session admission and fire ack cannot be one
   cross-domain transaction under the gateway rules. Stable fire/message IDs
   and boot replay close duplication without pretending atomicity.
2. **Persistent command resource use:** persistent sources have no deadline by
   design, matching the monitor precedent. The five-per-session cap and
   explicit cancellation are the first-slice bounds; a global host process cap
   would be a separate Owner decision.
3. **Restarted source repetition and orphaning:** a command is restarted from
   configuration, not resurrected. Source-level repetition is at-least-once
   and is disclosed by fire IDs/fingerprints. A detached group outside the
   deployment supervisor's kill domain may outlive a hard host crash and cannot
   be safely rediscovered; this subsystem neither signals a guessed PID nor
   presents command side effects as exactly-once world observation.
4. **Filesystem replacement:** rejecting inode/device changes can require the
   Owner to create a new trigger after an atomic file rotation. That friction is
   preferable to following a path whose identity changed under the watcher.
5. **Protocol namespace ratchet:** `Trigger` must be named in the core-model
   Tier-2 vocabulary and the additive schema snapshot reviewed before code
   lands. The status row must remain `designed, not implemented` until the
   whole vertical slice is wired.

## 15. Non-goals and reference provenance

This slice does not resurrect the historical Cron API, translate rows from
`0004_cron_job`, add trigger editing/deletion, run a remote watcher, or create
a separate daemon. OS process resurrection is explicitly out of scope: the
service manager may restart the app, while the app starts new command children
from durable configuration. Keeping the app and descendants in one
crash-cleanup kill domain is an operational supervisor concern, not PID
reattachment by Trigger. A durable notifier-suppression cache, per-source
checkpointing of unflushed output, and exactly-once world observation are also
out of scope; the durable boundary is the recorded Fire and the idempotent
Resident admission.

Semantic reference only (not imported, copied, or added as a dependency):

- `/Users/ino/.local/share/npm/global/lib/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/loop/scheduler.js`
- `/Users/ino/.local/share/npm/global/lib/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/loop/store.js`
- `/Users/ino/.local/share/npm/global/lib/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/loop/cron-planner.js`
- `/Users/ino/.local/share/npm/global/lib/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/loop/types.d.ts`
- `/Users/ino/.local/share/npm/global/lib/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/terminal/monitor-notify.js`
- `/Users/ino/.local/share/npm/global/lib/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/terminal/monitor-registry.js`
- `/Users/ino/.local/share/npm/global/lib/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/terminal/output-format.js`
- `/Users/ino/.local/share/npm/global/lib/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/terminal/tools/monitor.js`

The port is semantic: injected clock/timer folds, durable coalescing, bounded
notification, line framing, terminal summaries, and file identity checks. No
senpi sidecar, PTY object, terminal registry, or command vocabulary is part of
OpenOmni's contract.