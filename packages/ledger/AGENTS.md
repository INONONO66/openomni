# packages/ledger

Durable state substrate: session lifecycle, message/part storage, hash-chained bus persistence, artifacts, surface-key records, worker-run records, actor/grant/blacklist/pending stores, and the WorkItem store used by the OpenOmni kernel. Depends on `@openomni/protocol` and `@openomni/telemetry`.

SSOT directive ([docs/gateway-design.md](../../docs/gateway-design.md) §4, Owner 2026-08-19): "exactly one database, owned by `@openomni/ledger` (the #502 rename of session's storage). No package other than ledger touches the storage engine — every read/write goes through ledger's typed store surfaces." This package is the single storage engine owner; row schemas stay in `protocol`.

`Bus` itself lives in `@openomni/telemetry` (#606) — every consumer imports it from there directly; this package keeps the durable journal that subscribes to it.

This package stores facts; the kernel decides their product meaning. Communication routing, actor authority, PendingInteraction/PendingAsk precedence, worker grant semantics, and writeback belong in `@openomni/openomni`.

`WorkerRunStateStore`, `PendingAskStore`, and `PendingInteractionStore` are FROZEN legacy storage surfaces: every write throws a typed frozen error (#510 D2b / #548) and historical rows stay readable; the attempt-run view (`WorkItemAttemptRun`) read-upcasts them. New delegated-execution writes use the canonical WorkItem attempt and `Wait` contracts in the [kernel contract](../../docs/kernel-contract.md).

## STRUCTURE

```
src/
├── index.ts              # Package barrel — re-exports all namespaces
├── session/
│   ├── index.ts          # Session namespace barrel: public Session.* API re-exports
│   ├── events.ts         # Session bus event descriptors
│   ├── lifecycle.ts      # Session CRUD, child sessions, worker meta, TTL lazy deletion
│   ├── messages.ts       # Message/part writes and reads, message status
│   ├── transcript.ts     # TranscriptStore (#547 C3) — append-only transcript_fact recording; message/part tables are fold projections
│   └── info.ts           # SessionInfo schema (leaf — breaks session ↔ storage cycle)
├── storage/
│   ├── index.ts          # Barrel
│   ├── storage.ts        # Storage.Adapter interface + Storage singleton
│   ├── sqlite-storage.ts # SqliteStorageAdapter facade (Bun SQLite persistence)
│   ├── sqlite-*-adapter.ts # SQLite sub-adapters by storage seam
│   ├── sqlite-schema-lifecycle.ts # PRAGMAs, migrations, and clear ordering
│   ├── migration-runner.ts / sqlite-busy.ts / sqlite-json-data.ts / timestamped-store.ts # shared SQLite helpers (requireSubAdapter lives in timestamped-store)
│   └── initialize.ts     # initialize({ dbPath }) — bootstraps the default SQLite adapter
├── ledger-core/          # Ledger append core (#510 A): serialized CAS append, adoptStream, headFact/factsByType, verifyTail over the hash-chained ledger_event table (schema.ts = drizzle DDL source)
├── bus-persistence/      # Durable hash-chained bus event journal + BusQuery (stats/errors/history/verifyChainIntegrity)
├── actor/                # ActorIdentity / ActorEndpoint registry stores
├── blacklist/            # Blacklist entry store (absolute deny gate data)
├── channel-grant/        # ChannelGrant store (surface/workspace/channel ceilings)
├── pending-ask/          # PendingAskStore (legacy resident.ask path; #215 target freezes writes and read-upcasts to Wait)
├── pending-interaction/  # PendingInteractionStore (legacy correlation/follow-up records; #215 target read-upcasts to Wait)
├── worker-grant/         # WorkerGrantStore (scoped worker-egress grants)
├── artifact/             # Artifact.store / get — latest-version-wins upsert over SQLite (fail-closed on absent sub-adapter)
├── app-connector/        # AppConnectorInstallationStore for durable installed-app lifecycle records
├── surface-key/          # SurfaceKey — N:1 mapping from external surface keys to session IDs
├── wait/                 # WaitStore — durable Wait contract (#215/#510 B): fact-before-projection appends on wait:<id> streams, typed Wait.StoreError fail-closed, lazy pre-cutover adoption (identity-only genesis)
├── effect/               # EffectStore (#492) — intent→terminal-outcome effect ledger on effect:<id> streams; outstandingIntents/terminalIntents reconciliation reads
├── work-item/            # WorkItemStore — universal work state engine
│   ├── index.ts          # WorkItemStore namespace barrel: public WorkItemStore.* API
│   ├── create.ts         # Work item creation, parent linkage, Created event
│   ├── crud.ts           # get/list/remove/update plus relation cleanup
│   ├── lifecycle.ts      # start/fail/cancel plus typed raw-completion refusal, blockers, evidence
│   ├── mutation.ts       # mutation persistence, transition validation, Updated/StatusChanged events
│   ├── facts.ts          # #510 C1 decision-class fact appends on work:<hash>: head==revision CAS, lazy adoption (full-snapshot genesis — recorded #606 divergence), typed revision/duplicate/unavailable errors
│   ├── completion-writer.ts # authorized completion-authority writer: admission fact append before the projection CAS, one transaction (#510 C1)
│   ├── effect-link.ts    # projects effect intent/outcome records onto completionFacts.effects through the completion writer (#492 ↔ #490)
│   ├── attempt-run.ts    # WorkItemAttemptRun — run lifecycle over attempt facts + deterministic upcast of frozen worker_run_state rows (#510 D2b)
│   ├── dependency.ts     # dependency readiness + cycle detection
│   ├── retry.ts / retry-policy.ts # retry defaults + kernel-enforced exhaustion blocker
│   ├── outcome.ts        # Owner adoption outcome recording (adopted/corrected/redone/ignored)
│   ├── builder.ts        # WorkItem.Info construction
│   └── types.ts          # Internal WorkItemStore implementation types
└── worker-run/           # WorkerRunStateStore — frozen worker_run_state archive (reads only)
```

### Circular Dependency Avoidance

`session/info.ts` is a leaf with zero internal imports. `storage/storage.ts` imports `../session/info` (NOT `../session`). Session implementation files import `../storage/storage`; `session/index.ts` is a namespace barrel and does not import storage directly. This breaks the session ↔ storage cycle.

## KEY PATTERNS

- **Namespace API**: `Session.create()`, `Session.addMessage()`, `Session.addPart()`, `Session.createChild()`, `Session.update()`, etc. No class instances. Worker metadata lives on `SessionInfo.workerMeta` and round-trips through `update`/`get` (the dedicated accessors were dead surface, removed in #606).
- **Storage.Adapter**: There is no default adapter — `Storage.get()` before `initialize({ dbPath })`/`configure(adapter)` throws (fail-closed, #522; no silent `:memory:` fallback). `SqliteStorageAdapter` is the Bun SQLite persistent backend bootstrapped via `initialize({ dbPath })`. Its facade wires focused SQLite sub-adapter modules for required `session` / `message` / `part` and, required-in-production but optional-in-type for test fakes, `artifact`, `surfaceKey`, `cronJob`, `workItem`, `workerRunState`, and `appConnectorInstallation`. App connector installation records include Owner consent metadata plus disable/uninstall lifecycle operations because the installation record is the lifecycle SSOT. Schema lifecycle concerns that must evolve together (PRAGMAs, ordered migrations, clear ordering) live in `sqlite-schema-lifecycle.ts`. Stores consuming an absent sub-adapter fail closed (`requireSubAdapter` or a typed adapter_absent error), never degrade silently.
- **Legacy task/todo tables**: dropped by migration `0017_drop_dead_tables` (#606) — `event_log`, `task`, `task_run`, `task_idempotency`, `plan`, `todo`, `background_task` had zero readers and writers; their features live on the WorkItem projection + ledger and `bus_event`.
- **Bus events**: `Session.Event.Created`, `.Updated`, `.Deleted` are published on mutation. `worker.run.*` lifecycle events are published by the server worker runner (wire contract), never by this package — the frozen store publishes nothing.
- **SurfaceKey records**: N:1 mapping from surface-specific keys (e.g. `telegram:botId:chat:chatId`) to session IDs, stored solely in `Storage.Adapter.surfaceKey` (no in-memory index); a missing sub-adapter fails closed — ownership answers are never fabricated (#522). This package stores and looks up the mapping; `openomni` decides when the mapping wins over PendingInteraction or other routing facts.
- **WorkItemStore namespace**: `WorkItemStore.create()`, `.get()`, `.list()`, `.start()`, `.fail()`, `.cancel()`, `.assignExecution()`, `.allocateAttempt()`, `.addBlocker()`, `.resolveBlocker()`, `.addEvidence()`, `.addReadBackEvidence()`, `.recordEffect()`, and `.retry()` own lower-layer storage semantics; every mutation is a dedicated lifecycle helper (the freeform `.update()` and `.remove()`/`.recordOutcome()`/`.areDependenciesMet()` dead surface was removed in #606). There is NO raw completion entry point: the old `.complete()` tombstone is deleted, so completion is reachable only through the admission writer returned by `Storage.configure` — OpenOmni owns completion fact/admission appends and the terminal CAS. `parentHash` and stable completion criteria are immutable by construction.
- **WorkerRunStateStore**: the frozen `worker_run_state` archive (#510 D2b, pending-ask precedent). Reads (`get` / `listBySession` / `listByStatus`) keep serving historical rows — including the upcast-on-read attempt-run view in `WorkItemAttemptRun.find` — while every write throws the typed `WorkerRun.FrozenError` (`worker_run_frozen`) and persists nothing. Run lifecycle lives on WorkItem attempt facts (`work_item.attempt_allocated` / `attempt_finished`).
- **TTL / lazy deletion**: `Session.create({ ttlMs })` sets `expiresAt`; `Session.get()` and `.list()` check expiry and auto-delete.
- **Session lineage**: `Session.createChild()` + `parentSessionId` + `spawnDepth` are the current foundation for original → self-loop → child Worker trees. Future work should add explicit metadata conventions before adding new storage shapes.

## STORE SEMANTICS

Stores may provide CRUD and indexed queries:

- `PendingInteractionStore.findByCorrelation(...)` may return candidate records.
- `PendingAskStore.findByCorrelation(...)` may remain while the legacy resident.ask path exists.
- `ChannelGrantStore` / `BlacklistStore` may persist and retrieve records.
- `WorkerGrantStore` may persist grants and expose data needed for evaluation.

Stores must not own kernel decisions:

- Do not decide whether PendingInteraction takes precedence over SurfaceKey.
- Do not decide whether an actor is trusted enough to enter a channel.
- Do not decide whether a worker may create a new external task.
- Do not route messages to Resident/Worker/session/surface.
- Do not perform writeback or projection policy.

If a store method starts combining multiple product facts into an allow/deny/routing result, move that logic to `packages/openomni` and keep only the indexed data access here.

## ANTI-PATTERNS

- **Storage API tiers**: `Storage.get()` is the public low-level API for accessing optional sub-adapters such as `workItem` and `workerRunState` from outside this package. For core session operations (session/message/part CRUD), prefer the namespace APIs (`Session.*`, `Artifact.*`, `SurfaceKey.*`) for package-level invariants; note that bus publication is operation-specific. `Storage.getAdapter()` is an internal alias — both return the same adapter.
- Do NOT import internal paths from other packages — import from `@openomni/ledger` (index re-exports).
- Do NOT persist ad-hoc delegated execution state alongside `Session`. `worker_run_state` is a frozen read-only archive; new writes use the canonical WorkItem attempt contract rather than reviving the legacy shape.
- Do NOT write raw self-loop transcripts back into the original user session. Store internal work in child sessions and let `openomni` decide what distilled result belongs in the original session.
- Do NOT add communication routing or authority evaluation here. The ledger is the durable substrate; OpenOmni is the kernel.
- Do NOT add a second completion-admission append or terminal method here. The only product completion boundary is `packages/openomni/src/work-item/`.

_Edited 2026-08-10 per Owner-approved clean-room corpus (local docs/corpus, session record)._
